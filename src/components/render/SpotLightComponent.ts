import { vec3, vec4, mat4 } from 'gl-matrix';
import { Technique } from '../../renderer/resources/Technique';
import { CameraComponent } from './CameraComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { SpotLightComponentData } from '../../types/SpotLightComponentData.type';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Texture } from '../../renderer/resources/Texture';
import { AABB } from '../../core/math/AABB';

const ndcCorners = [
  [-1, -1, -1, 1],
  [1, -1, -1, 1],
  [-1, 1, -1, 1],
  [1, 1, -1, 1],

  [-1, -1, 1, 1],
  [1, -1, 1, 1],
  [-1, 1, 1, 1],
  [1, 1, 1, 1],
];

export class SpotLightComponent extends CameraComponent {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;
  private startFallof = 0.0;
  private _hasShadows = false;
  private _isVisible = false;
  private shadowWidth = 1024;
  private shadowHeight = 1024;
  private projectorTexture!: Texture;
  private projectorTextureView!: GPUTextureView;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private shadowDepthTexture!: GPUTexture;
  private shadowDepthView!: GPUTextureView;
  private shadowSampler!: GPUSampler;
  private modelUniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;

  private technique!: Technique;

  // ✅ Reusable buffers for GPU writes (zero allocations in updateLightUniforms)
  private colorBuffer = new Float32Array(4);
  private positionBuffer = new Float32Array(4);
  private radiusBuffer = new Float32Array(1);
  private shadowStepBuffer = new Float32Array(1);
  private shadowInvResBuffer = new Float32Array(1);
  private shadowStepDivResBuffer = new Float32Array(1);
  private falloffBuffer = new Float32Array(4);
  private paddingBuffer = new Float32Array(3);
  private extraPaddingBuffer = new Float32Array(1);

  private aabb: AABB = new AABB();

  constructor() {
    super();
  }

  public override async load(data: SpotLightComponentData): Promise<void> {
    if (data.color) {
      vec4.copy(this.color, data.color);
    }

    if (data.intensity) {
      this.intensity = data.intensity;
    }

    if (data.radius) {
      this.radius = data.radius;
    }

    this.camera.setNearPlane(Math.max(0.01, this.radius * 0.005));
    this.camera.setFarPlane(this.radius * 1.1);

    if (data.fov) {
      this.camera.setFov(data.fov);
    }

    if (data.viewport) {
      this.camera.setViewport(data.viewport.width, data.viewport.height);
    } else {
      this.camera.setViewport(this.shadowWidth, this.shadowHeight);
    }

    if (data.shadowWidth) {
      this.shadowWidth = data.shadowWidth;
    }

    if (data.shadowHeight) {
      this.shadowHeight = data.shadowHeight;
    }

    if (data.startFallof) {
      this.startFallof = data.startFallof;
    }

    if (data.hasShadows) {
      this._hasShadows = data.hasShadows;
    }

    if (data.isOrtho) {
      this.camera.setOrthoParams(
        data.orthoCentered || true,
        data.orthoLeft || 0,
        data.orthoWidth || 1,
        data.orthoTop || 0,
        data.orthoHeight || 1,
      );
    }

    this.projectorTexture = await Texture.getAsync(data.projector ? data.projector : 'white.png');
    this.projectorTextureView = this.projectorTexture.getTextureView()!;

    this.camera.lookAt(data.position ?? [0, 0, 0], data.target ?? [0, 0, 1]);

    // Crear textura de profundidad para shadow mapping
    this.shadowDepthTexture = GPUUtils.createTexture(
      'spot_light_shadow_depth_map',
      this.shadowWidth,
      this.shadowHeight,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );

    this.shadowDepthView = this.shadowDepthTexture.createView({
      aspect: 'depth-only',
    });

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = SamplerLibrary.shadows;

    this.technique = await Technique.getAsync(
      this._hasShadows ? 'lighting/spot_light_shadows.tech' : 'lighting/spot_light.tech',
    );
    this.uniformBuffer = GPUUtils.createBuffer(
      'spot light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      `spot light bind group`,
      this.technique.getPipeline().getBindGroupLayout(3)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.shadowDepthView, // Textura de profundidad
        },
        {
          binding: 2,
          resource: this.shadowSampler, // Sampler de comparación
        },
        {
          binding: 3,
          resource: this.projectorTextureView!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler,
        },
      ],
    );

    const modelBindGroupLayout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.OBJECT_UNIFORMS,
    );

    this.modelUniformBuffer = GPUUtils.createBuffer(
      'spot_light_transform_uniformBuffer',
      16 * 4, // 1 matriz 4x4 (model)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const res = mat4.create();
    mat4.invert(res, this.camera.getViewProjection());
    GPUUtils.writeBuffer(this.modelUniformBuffer, 0, new Float32Array(res));

    // Bind group para la matriz de modelo
    this.modelBindGroup = BindGroupFactory.createBindGroup(
      `transform_modelBindGroup`,
      modelBindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.modelUniformBuffer },
        },
      ],
    );

    this.camera.updateUniforms(0);
    this.updateLightUniforms();
    this.calculateWorldAABB();
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(2, this.modelBindGroup); //for model matrix
    pass.setBindGroup(3, this.uniformBindGroup); // spot light parameters
  }

  private updateLightUniforms(): void {
    // ✅ Update reusable buffers instead of creating new Float32Arrays
    this.colorBuffer[0] = this.color[0];
    this.colorBuffer[1] = this.color[1];
    this.colorBuffer[2] = this.color[2];
    this.colorBuffer[3] = this.color[3];

    this.positionBuffer[0] = this.position[0];
    this.positionBuffer[1] = this.position[1];
    this.positionBuffer[2] = this.position[2];
    this.positionBuffer[3] = this.intensity;

    this.radiusBuffer[0] = this.radius;

    const shadowStep = 1.0;
    this.shadowStepBuffer[0] = shadowStep;

    const shadowInverseResolution = 1.0 / this.shadowWidth;
    this.shadowInvResBuffer[0] = shadowInverseResolution;

    const shadowStepDivResolution = shadowStep / this.shadowWidth;
    this.shadowStepDivResBuffer[0] = shadowStepDivResolution;

    this.falloffBuffer[0] = this.startFallof;
    this.falloffBuffer[1] = 0.0;
    this.falloffBuffer[2] = 0.0;
    this.falloffBuffer[3] = 0.0;

    this.paddingBuffer[0] = 0.0;
    this.paddingBuffer[1] = 0.0;
    this.paddingBuffer[2] = 0.0;

    this.extraPaddingBuffer[0] = 0.0;

    GPUUtils.writeBuffer(this.uniformBuffer, 0, this.colorBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 16, this.positionBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 32, new Float32Array(this.camera.getViewProjection()));
    GPUUtils.writeBuffer(this.uniformBuffer, 96, this.radiusBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 100, this.shadowStepBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 104, this.shadowInvResBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 108, this.shadowStepDivResBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 112, this.falloffBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 116, this.paddingBuffer);
    GPUUtils.writeBuffer(this.uniformBuffer, 128, this.extraPaddingBuffer);

    GPUUtils.writeBuffer(
      this.modelUniformBuffer,
      0,
      new Float32Array(this.camera.getInvViewProjectionMatrix()),
    );
  }

  public generateShadowMap(): void {
    RenderManager.getInstance().performCulling(this.camera, RenderCategory.SHADOWS);
    const render = Render.getInstance();

    // Solo renderizar a la textura de profundidad (sin color attachment)
    const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(this.shadowDepthView!);

    const pass = render.getCommandEncoder().beginRenderPass(
      GPUUtils.createRenderPassDescriptor(
        'spot light shadow map render pass',
        [], // Sin color attachments
        depthStencilAttachment,
      ),
    );
    GPUUtils.configureViewportAndScissor(pass, this.shadowWidth, this.shadowHeight);

    RenderManager.getInstance().setCamera(this.camera);

    RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

    pass.end();
  }

  private calculateWorldAABB(): void {
    const invViewProj = this.camera.getInvViewProjectionMatrix();

    const min = vec3.fromValues(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );

    const max = vec3.fromValues(
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );

    for (const c of ndcCorners) {
      const v = vec4.fromValues(c[0], c[1], c[2], c[3]);
      vec4.transformMat4(v, v, invViewProj);

      // perspective divide
      v[0] /= v[3];
      v[1] /= v[3];
      v[2] /= v[3];

      min[0] = Math.min(min[0], v[0]);
      min[1] = Math.min(min[1], v[1]);
      min[2] = Math.min(min[2], v[2]);

      max[0] = Math.max(max[0], v[0]);
      max[1] = Math.max(max[1], v[1]);
      max[2] = Math.max(max[2], v[2]);
    }

    this.aabb.min = min;
    this.aabb.max = max;
  }

  public override update(dt: number): void {}

  public override renderInMenu(): void {}

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }

  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public getShadowDepthView(): GPUTextureView {
    return this.shadowDepthView;
  }

  public getProjectorTextureView(): GPUTextureView {
    return this.projectorTextureView;
  }

  public getShadowSampler(): GPUSampler {
    return this.shadowSampler;
  }

  public hasShadows(): boolean {
    return this._hasShadows;
  }

  public isVisible(): boolean {
    return this._isVisible;
  }

  public setIsVisible(visible: boolean): void {
    this._isVisible = visible;
  }

  public getAABB(): AABB {
    return this.aabb;
  }
}
