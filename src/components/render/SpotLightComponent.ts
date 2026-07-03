import { vec3, vec4, mat4 } from 'gl-matrix';
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
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';

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
    this.camera.setUseReverseZ(false);
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

    // Load projector texture
    [this.projectorTexture] = await Promise.all([
      Texture.getAsync(data.projector ? data.projector : 'white.png'),
    ]);
    this.projectorTextureView = this.projectorTexture.getTextureView()!;
    this.uniformBuffer = GPUUtils.createBuffer(
      'spot light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      `spot light bind group`,
      BindGroupFactory.getLayoutFromEnum(PipelineBindGroupLayouts.SPOT_LIGHT_UNIFORMS),
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
      16 * 4 * 2, // ObjectUniforms = modelMatrix (64) + previousModelMatrix (64) = 128 bytes
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

    const spotShadowDesc = GPUUtils.createRenderPassDescriptor(
      'spot light shadow map render pass',
      [], // Sin color attachments
      depthStencilAttachment,
    );
    const spotShadowTs = GPUProfiler.getInstance().getTimestampWrites('Spot Shadow');
    if (spotShadowTs) spotShadowDesc.timestampWrites = spotShadowTs;
    const pass = render.getCommandEncoder().beginRenderPass(spotShadowDesc);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (!folder) return;

    const p = {
      r: this.color[0]!,
      g: this.color[1]!,
      b: this.color[2]!,
      intensity: this.intensity,
      radius: this.radius,
      startFalloff: this.startFallof,
      fov: this.camera.getFov(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addAxisControls = (
      parent: any,
      obj: any,
      key: string,
      label: string,
      stepRef: { v: number },
      onChange: () => void,
    ): void => {
      parent.add(obj, key).step(0.001).name(label).listen().onChange(onChange);
      parent
        .add(
          {
            fn: () => {
              obj[key] -= stepRef.v;
              onChange();
            },
          },
          'fn',
        )
        .name(`${label}  −`);
      parent
        .add(
          {
            fn: () => {
              obj[key] += stepRef.v;
              onChange();
            },
          },
          'fn',
        )
        .name(`${label}  +`);
    };

    const slFolder = folder.addFolder('Spot Light');
    slFolder.close();

    const applyColor = () => this.setColor(p.r, p.g, p.b);
    const colorStep = { v: 0.05 };
    slFolder.add(colorStep, 'v').step(0.001).name('± Step (color)');
    addAxisControls(slFolder, p, 'r', 'R', colorStep, applyColor);
    addAxisControls(slFolder, p, 'g', 'G', colorStep, applyColor);
    addAxisControls(slFolder, p, 'b', 'B', colorStep, applyColor);

    const intStep = { v: 0.1 };
    slFolder.add(intStep, 'v').step(0.001).name('± Step (intensity)');
    addAxisControls(slFolder, p, 'intensity', 'Intensity', intStep, () =>
      this.setIntensity(p.intensity),
    );

    const radStep = { v: 0.5 };
    slFolder.add(radStep, 'v').step(0.001).name('± Step (radius)');
    addAxisControls(slFolder, p, 'radius', 'Radius', radStep, () => this.setRadius(p.radius));

    const fallStep = { v: 0.1 };
    slFolder.add(fallStep, 'v').step(0.001).name('± Step (falloff)');
    addAxisControls(slFolder, p, 'startFalloff', 'Start Falloff', fallStep, () =>
      this.setStartFalloff(p.startFalloff),
    );

    const fovStep = { v: 5.0 };
    slFolder.add(fovStep, 'v').step(0.1).name('± Step (fov°)');
    addAxisControls(slFolder, p, 'fov', 'FOV °', fovStep, () => this.setFov(p.fov));
  }

  public override renderDebug(filter?: string): void {
    if (filter && filter !== 'render' && filter !== 'all') return;
    const invVP = this.camera.getInvViewProjectionMatrix();
    PhysicsDebugDrawer.getInstance().addFrustumSlices(invVP, [1.0, 0.5, 0.0, 1.0]);
  }

  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public override getCamera() {
    return this.camera;
  }

  public getColor(): vec4 {
    return this.color;
  }

  public getIntensity(): number {
    return this.intensity;
  }

  public getRadius(): number {
    return this.radius;
  }

  public getStartFalloff(): number {
    return this.startFallof;
  }

  public getFov(): number {
    return this.camera.getFov();
  }

  public setColor(r: number, g: number, b: number): void {
    vec4.set(this.color, r, g, b, this.color[3]);
    this.updateLightUniforms();
  }

  public setIntensity(v: number): void {
    this.intensity = v;
    this.updateLightUniforms();
  }

  public setRadius(v: number): void {
    this.radius = v;
    this.updateLightUniforms();
  }

  public setStartFalloff(v: number): void {
    this.startFallof = v;
    this.updateLightUniforms();
  }

  public setFov(degrees: number): void {
    this.camera.setFov(degrees);
    this.camera.updateUniforms(0);
    this.updateLightUniforms();
    this.calculateWorldAABB();
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
