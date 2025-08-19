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

export class SpotLightComponent extends CameraComponent {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;
  private startFallof = 0.0;
  private _hasShadows = false;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private shadowDepthTexture!: GPUTexture;
  private shadowDepthView!: GPUTextureView;
  private shadowSampler!: GPUSampler;
  private modelUniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;

  private technique!: Technique;

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

    if (data.near) {
      this.camera.setNearPlane(data.near);
    }

    if (data.far) {
      this.camera.setFarPlane(data.far);
    }

    if (data.fov) {
      this.camera.setFov(data.fov);
    }

    if (data.viewport) {
      this.camera.setViewport(data.viewport.width, data.viewport.height);
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

    this.camera.lookAt(data.position, data.target);

    // Crear textura de profundidad para shadow mapping
    this.shadowDepthTexture = GPUUtils.createTexture(
      'spot_light_shadow_depth_map',
      2048, // Resolución más alta para mejores sombras
      2048,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );

    this.shadowDepthView = this.shadowDepthTexture.createView({
      aspect: 'depth-only',
    });

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = Render.getInstance().getDevice().createSampler({
      label: 'spot_light_shadow_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      compare: 'less', // Función de comparación para shadows
    });

    this.technique = await Technique.get(
      this._hasShadows ? 'spot_light_shadows.tech' : 'spot_light.tech',
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

    this.camera.updateUniforms();
    this.updateLightUniforms();
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(2, this.modelBindGroup); //for model matrix
    pass.setBindGroup(3, this.uniformBindGroup); // spot light parameters
  }

  private updateLightUniforms(): void {
    GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array(this.color));
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array(
        vec4.fromValues(this.position[0], this.position[1], this.position[2], this.intensity),
      ),
    );

    // Calculate LightViewProjOffset matrix
    const mtx_scale = mat4.create();
    const mtx_translation = mat4.create();
    const mtx_offset = mat4.create();
    const lightViewProjOffset = mat4.create();

    mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]);
    mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);
    mat4.multiply(mtx_offset, mtx_scale, mtx_translation);
    mat4.multiply(lightViewProjOffset, this.camera.getViewProjection(), mtx_offset);

    // Escribir la matriz lightViewProjOffset completa (NO solo ViewProjection)
    GPUUtils.writeBuffer(this.uniformBuffer, 32, new Float32Array(this.camera.getViewProjection())); // radius (f32) - bytes 96-99 (no se usa para directional light)
    GPUUtils.writeBuffer(this.uniformBuffer, 96, new Float32Array([this.radius]));

    // shadowStep (f32) - bytes 100-103
    const shadowStep = 2.0;
    GPUUtils.writeBuffer(this.uniformBuffer, 100, new Float32Array([shadowStep]));

    // shadowInverseResolution (f32) - bytes 104-107
    const shadowInverseResolution = 1.0 / 2048.0;
    GPUUtils.writeBuffer(this.uniformBuffer, 104, new Float32Array([shadowInverseResolution]));

    // shadowStepDivResolution (f32) - bytes 108-111
    const shadowStepDivResolution = shadowStep / 2048.0;
    GPUUtils.writeBuffer(this.uniformBuffer, 108, new Float32Array([shadowStepDivResolution]));

    // startFalloff (f32) - bytes 112-115 (no se usa para directional light)
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      112,
      new Float32Array(vec4.fromValues(this.startFallof, 0.0, 0.0, 0.0)),
    );

    // padding (vec3) - bytes 116-127
    GPUUtils.writeBuffer(this.uniformBuffer, 116, new Float32Array([0.0, 0.0, 0.0]));

    // extraPadding (f32) - bytes 128-131
    GPUUtils.writeBuffer(this.uniformBuffer, 128, new Float32Array([0.0]));
  }

  public generateShadowMap(): void {
    if (!this.camera.getIsDirty()) return;

    RenderManager.getInstance().performCulling(this.camera);
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
    GPUUtils.configureViewportAndScissor(pass, 2048, 2048); // Usar resolución de shadow map

    RenderManager.getInstance().setCamera(this.camera);

    RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

    pass.end();
  }

  public override update(_dt: number): void {}

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }

  public hasShadows(): boolean {
    return this._hasShadows;
  }
}
