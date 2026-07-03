import { vec3, vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PointLightComponentData } from '../../types/PointLightComponentData.type';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Texture } from '../../renderer/resources/Texture';
import { AABB } from '../../core/math/AABB';
import { Camera } from '../../core/math/Camera';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';

// WebGPU cube face order: +X, -X, +Y, -Y, +Z, -Z
// Up vectors match the WebGPU/Vulkan cubemap sampling convention (v=0 at top).
// In WebGPU, NDC y=1 maps to texture v=0 (top), so no Y-flip is needed.
const CUBE_FACE_SETUPS = [
  { target: vec3.fromValues(1, 0, 0), up: vec3.fromValues(0, 1, 0) }, // +X
  { target: vec3.fromValues(-1, 0, 0), up: vec3.fromValues(0, 1, 0) }, // -X
  { target: vec3.fromValues(0, 1, 0), up: vec3.fromValues(0, 0, -1) }, // +Y
  { target: vec3.fromValues(0, -1, 0), up: vec3.fromValues(0, 0, 1) }, // -Y
  { target: vec3.fromValues(0, 0, 1), up: vec3.fromValues(0, 1, 0) }, // +Z
  { target: vec3.fromValues(0, 0, -1), up: vec3.fromValues(0, 1, 0) }, // -Z
] as const;

export class PointLightComponent extends Component {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;
  private startFallof = 0.0;
  private isDirty = true;
  private _isVisible = false;
  private _hasShadows = false;
  private projectorTexture!: Texture;
  private projectorTextureView!: GPUTextureView;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;

  private dummyShadowTexture!: GPUTexture;
  private dummyShadowTextureView!: GPUTextureView;

  private _shadowTarget = vec3.create();

  // Shadow resources (only created when hasShadows = true)
  private shadowResolution = 512;
  private shadowNear = 0.05;
  private shadowCubeTexture!: GPUTexture;
  private shadowCubeFaceViews: GPUTextureView[] = []; // 6 face views for rendering
  private shadowCubeView!: GPUTextureView; // cube view for sampling
  private shadowCameras: Camera[] = []; // 6 per-face cameras

  // ✅ Reusable buffers for GPU writes (zero allocations in update)
  private colorBuffer = new Float32Array(4);
  private positionBuffer = new Float32Array(4);
  private radiusBuffer = new Float32Array(4);
  private falloffBuffer = new Float32Array(4);

  private aabb: AABB = new AABB();

  constructor() {
    super();
  }

  public async load(data: PointLightComponentData): Promise<void> {
    if (data.color) {
      vec4.copy(this.color, data.color);
    }
    if (data.intensity) {
      this.intensity = data.intensity;
    }
    if (data.radius) {
      this.radius = data.radius;
    }
    if (data.startFallof) {
      this.startFallof = data.startFallof;
    }
    if (data.hasShadows) {
      this._hasShadows = data.hasShadows;
    }
    if (data.shadowResolution) {
      this.shadowResolution = data.shadowResolution;
    }

    this.shadowNear = Math.max(0.01, this.radius * 0.005);

    this.uniformBuffer = GPUUtils.createBuffer(
      'point light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.projectorTexture = await Texture.getAsync('white.png');
    this.projectorTextureView = this.projectorTexture.getTextureView()!;

    if (this._hasShadows) {
      this.initShadowResources();
    } else {
      // Dummy cubemap shadow texture to satisfy the bind group layout (must be cubemap, not 2D)
      this.dummyShadowTexture = GPUUtils.getDevice().createTexture({
        label: 'dummy_shadow_texture_point_light',
        size: [1, 1, 6],
        dimension: '2d',
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.dummyShadowTextureView = this.dummyShadowTexture.createView({
        dimension: 'cube',
        aspect: 'depth-only',
      });
    }

    this.buildBindGroup();
    this.calculateWorldAABB();
  }

  // ─── Shadow helpers ───────────────────────────────────────────────────────

  private initShadowResources(): void {
    const res = this.shadowResolution;

    // 6-layer 2D texture treated as a cubemap
    this.shadowCubeTexture = GPUUtils.getDevice().createTexture({
      label: 'point_light_shadow_cube',
      size: [res, res, 6],
      dimension: '2d',
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // One face view per layer for rendering
    this.shadowCubeFaceViews = [];
    for (let face = 0; face < 6; face++) {
      this.shadowCubeFaceViews.push(
        this.shadowCubeTexture.createView({
          label: `point_shadow_face_${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        }),
      );
    }

    // Cube view for shader sampling
    this.shadowCubeView = this.shadowCubeTexture.createView({
      label: 'point_shadow_cube_view',
      dimension: 'cube',
      aspect: 'depth-only',
    });

    // 6 cameras — one per cube face
    this.shadowCameras = [];
    for (let face = 0; face < 6; face++) {
      const cam = new Camera();
      cam.setUseReverseZ(false);
      cam.setFov(90);
      cam.setNearPlane(this.shadowNear);
      cam.setFarPlane(this.radius);
      cam.setViewport(this.shadowResolution, this.shadowResolution);
      this.shadowCameras.push(cam);
    }
  }

  private buildBindGroup(): void {
    const layout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.POINT_LIGHT_SHADOW_UNIFORMS,
    );
    const shadowResource = this._hasShadows ? this.shadowCubeView : this.dummyShadowTextureView;

    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      'point light uniform bind group',
      layout,
      [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: shadowResource },
        { binding: 2, resource: SamplerLibrary.shadows },
        { binding: 3, resource: this.projectorTextureView },
        { binding: 4, resource: SamplerLibrary.simpleSampler },
      ],
    );
  }

  // ─── Shadow generation ────────────────────────────────────────────────────

  public generateShadowMap(): void {
    if (!this._hasShadows) return;

    const render = Render.getInstance();
    const res = this.shadowResolution;

    // Update camera positions to current light world position before rendering
    for (let face = 0; face < 6; face++) {
      const setup = CUBE_FACE_SETUPS[face];
      vec3.add(this._shadowTarget, this.position, setup.target);
      this.shadowCameras[face].lookAt(this.position, this._shadowTarget, setup.up);
      this.shadowCameras[face].setIsDirty(true); // ← garantizar escritura al buffer
      this.shadowCameras[face].updateUniforms(0);
    }

    // One render pass per face
    for (let face = 0; face < 6; face++) {
      const cam = this.shadowCameras[face];
      RenderManager.getInstance().performCulling(cam, RenderCategory.SHADOWS);

      const depthAttachment = GPUUtils.createDepthStencilAttachment(this.shadowCubeFaceViews[face]);
      const faceDesc = GPUUtils.createRenderPassDescriptor(
        `point_light_shadow_face_${face}`,
        [],
        depthAttachment,
      );
      const faceTs = GPUProfiler.getInstance().getTimestampWrites('Point Shadow');
      if (faceTs) faceDesc.timestampWrites = faceTs;
      const pass = render.getCommandEncoder().beginRenderPass(faceDesc);
      GPUUtils.configureViewportAndScissor(pass, res, res);

      RenderManager.getInstance().setCamera(cam);
      RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

      pass.end();
    }
  }

  // ─── Per-frame update ─────────────────────────────────────────────────────

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(3, this.uniformBindGroup);
  }

  public update(_dt: number): void {
    if (this.isDirty) {
      const entity = this.getOwner();
      const transform = entity.getComponent('transform') as TransformComponent;
      transform
        .getTransform()
        .setLocalScale(vec3.fromValues(this.radius * 2.0, this.radius * 2.0, this.radius * 2.0));
      vec3.copy(this.position, transform.getTransform().getWorldPosition());

      this.colorBuffer[0] = this.color[0];
      this.colorBuffer[1] = this.color[1];
      this.colorBuffer[2] = this.color[2];
      this.colorBuffer[3] = this._hasShadows ? 1.0 : 0.0;

      this.positionBuffer[0] = this.position[0];
      this.positionBuffer[1] = this.position[1];
      this.positionBuffer[2] = this.position[2];
      this.positionBuffer[3] = this.intensity;

      this.radiusBuffer[0] = this.radius;
      this.radiusBuffer[1] = 0.0;
      this.radiusBuffer[2] = 0.0;
      this.radiusBuffer[3] = 0.0;

      this.falloffBuffer[0] = this.startFallof;
      this.falloffBuffer[1] = 0.0;
      this.falloffBuffer[2] = 0.0;
      this.falloffBuffer[3] = 0.0;

      GPUUtils.writeBuffer(this.uniformBuffer, 0, this.colorBuffer);
      GPUUtils.writeBuffer(this.uniformBuffer, 16, this.positionBuffer);
      this.radiusBuffer[0] = this.radius;
      this.radiusBuffer[1] = this._hasShadows ? this.shadowNear : 0.0; // shadowNear en [1]
      this.radiusBuffer[2] = this._hasShadows ? this.radius : 0.0; // shadowFar  en [2]
      this.radiusBuffer[3] = 0.0;

      GPUUtils.writeBuffer(this.uniformBuffer, 96, this.radiusBuffer); // un solo write limpio
      GPUUtils.writeBuffer(this.uniformBuffer, 112, this.falloffBuffer);

      this.calculateWorldAABB();
      this.isDirty = false;
    }
  }

  private calculateWorldAABB(): void {
    const r = this.radius;
    const pos = this.position;
    this.aabb.min = vec3.fromValues(pos[0] - r, pos[1] - r, pos[2] - r);
    this.aabb.max = vec3.fromValues(pos[0] + r, pos[1] + r, pos[2] + r);
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

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
  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public getWorldPosition(): vec3 {
    return this.position;
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

  public setColor(r: number, g: number, b: number): void {
    vec4.set(this.color, r, g, b, this.color[3]);
    this.isDirty = true;
  }

  public setIntensity(v: number): void {
    this.intensity = v;
    this.isDirty = true;
  }

  public setRadius(v: number): void {
    this.radius = v;
    this.isDirty = true;
  }

  public setStartFalloff(v: number): void {
    this.startFallof = v;
    this.isDirty = true;
  }

  public getShadowDepthView(): GPUTextureView {
    return this._hasShadows ? this.shadowCubeView : this.dummyShadowTextureView;
  }

  public getShadowSampler(): GPUSampler {
    return SamplerLibrary.shadows;
  }

  public debugInMenu(): void {}

  public override renderDebug(filter?: string): void {
    if (filter && filter !== 'render' && filter !== 'all') return;
    const pos = this.getWorldPosition();
    PhysicsDebugDrawer.getInstance().addSphere(pos[0]!, pos[1]!, pos[2]!, this.getRadius(), [1.0, 0.6, 0.0, 1.0]);
  }

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

    const plFolder = folder.addFolder('Point Light');
    plFolder.close();

    const applyColor = () => this.setColor(p.r, p.g, p.b);
    const colorStep = { v: 0.05 };
    plFolder.add(colorStep, 'v').step(0.001).name('± Step (color)');
    addAxisControls(plFolder, p, 'r', 'R', colorStep, applyColor);
    addAxisControls(plFolder, p, 'g', 'G', colorStep, applyColor);
    addAxisControls(plFolder, p, 'b', 'B', colorStep, applyColor);

    const intStep = { v: 0.1 };
    plFolder.add(intStep, 'v').step(0.001).name('± Step (intensity)');
    addAxisControls(plFolder, p, 'intensity', 'Intensity', intStep, () =>
      this.setIntensity(p.intensity),
    );

    const radStep = { v: 0.5 };
    plFolder.add(radStep, 'v').step(0.001).name('± Step (radius)');
    addAxisControls(plFolder, p, 'radius', 'Radius', radStep, () => this.setRadius(p.radius));

    const fallStep = { v: 0.1 };
    plFolder.add(fallStep, 'v').step(0.001).name('± Step (falloff)');
    addAxisControls(plFolder, p, 'startFalloff', 'Start Falloff', fallStep, () =>
      this.setStartFalloff(p.startFalloff),
    );
  }
}
