import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { FogScatterComponentData } from '../../types/FogScatterComponentData.type';
import { DirectionalLightComponent } from './DirectionalLightComponent';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Texture } from '../../renderer/resources/Texture';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { Render } from '../../renderer/core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';

/**
 * FogScatterComponent — Screen-space single-scatter fog.
 *
 * Two artistic effects:
 *   Effect 1 (scene blur):    objects inside dense fog lose sharpness in
 *                              proportion to actual transmittance.
 *   Effect 2 (lateral scatter): light bleeds laterally across shadow
 *                              boundaries inside the fog volume.
 *
 * Pipeline (6 passes):
 *   Pass 1 — fog_scatter_raymarch  → fogHalfRT (half-res scatter + transmittance)
 *   Pass 2 — bilateral blur H      → fogHalfBlurH
 *   Pass 3 — bilateral blur V      → fogHalfBlurred  (lateral scatter ready)
 *   Pass 4 — bilateral blur H      → sceneBlurH      (scene blur, quarter-res)
 *   Pass 5 — bilateral blur V      → sceneBlurred
 *   Pass 6 — fog_scatter_compose   → resultRT        (final frame)
 *
 * FogScatterParams layout (64 bytes = 16 × f32):
 *   [0]  density          [1]  heightBase      [2]  heightFalloff   [3]  extinctionCoeff
 *   [4]  scatterColor.r   [5]  scatterColor.g  [6]  scatterColor.b  [7]  numSteps
 *   [8]  fogNear          [9]  fogFar          [10] enabled         [11] _pad
 *   [12] ambientColor.r   [13] ambientColor.g  [14] ambientColor.b  [15] _pad2
 *
 * FogScatterComposeParams layout (16 bytes = 4 × f32):
 *   [0]  lateralScatterStrength  [1]  scatterStrength  [2]  enabled  [3]  _pad
 */
export class FogScatterComponent extends Component {
  // ─── Techniques + mesh ───────────────────────────────────────────────────────
  private raymarchTech!: Technique;
  private bilateralBlurTech!: Technique;
  private composeTech!: Technique;
  private mesh!: Mesh;

  // ─── Render targets ───────────────────────────────────────────────────────────
  private fogHalfRT!: RenderTarget;
  private fogHalfBlurH!: RenderTarget;
  private fogHalfBlurred!: RenderTarget;
  private sceneBlurH!: RenderTarget;
  private sceneBlurred!: RenderTarget;
  private resultRT!: RenderTarget;

  // ─── Uniform buffers ──────────────────────────────────────────────────────────
  private fogParamsBuffer!: GPUBuffer; // FogScatterParams (64 bytes)
  private composeParamsBuffer!: GPUBuffer; // FogScatterComposeParams (16 bytes)
  private fogBlurHBuffer!: GPUBuffer;
  private fogBlurVBuffer!: GPUBuffer;
  private sceneBlurHBuffer!: GPUBuffer;
  private sceneBlurVBuffer!: GPUBuffer;

  // ─── Bind groups ──────────────────────────────────────────────────────────────
  private fogParamsBindGroup: GPUBindGroup | null = null;
  private composeParamsBindGroup: GPUBindGroup | null = null;
  private fogComposeBG: GPUBindGroup | null = null;
  private blurDepthBG: GPUBindGroup | null = null;
  private cachedDepthView: GPUTextureView | null = null;
  private fogBlurHBG!: GPUBindGroup;
  private fogBlurVBG!: GPUBindGroup;
  private sceneBlurHBG!: GPUBindGroup;
  private sceneBlurVBG!: GPUBindGroup;
  private csmBindGroup: GPUBindGroup | null = null;
  private cachedShadowView: GPUTextureView | null = null;
  private blurInputBGCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private composeSceneBGCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ─── Blue noise ───────────────────────────────────────────────────────────────
  private blueNoiseTexture!: Texture;

  // ─── Parameters ───────────────────────────────────────────────────────────────
  private _enabled: boolean = true;
  public density: number = 0.012;
  public heightBase: number = 0.0;
  public heightFalloff: number = 0.08;
  public extinctionCoeff: number = 0.015;
  public scatterColor: [number, number, number] = [0.85, 0.92, 1.0];
  public numSteps: number = 16;
  public fogNear: number = 0.0;
  public fogFar: number = 500.0;
  public ambientColor: [number, number, number] = [0.4, 0.6, 1.0];
  public ambientStrength: number = 0.15;
  public lateralScatterStrength: number = 0.45;
  public scatterStrength: number = 0.6;

  private loaded = false;
  private readonly fogParamsData = new Float32Array(16);
  private readonly composeParamsData = new Float32Array(4);

  private _editorFolder: any = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  public async load(data?: FogScatterComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this._enabled = data.enabled;
      if (data.density !== undefined) this.density = data.density;
      if (data.heightBase !== undefined) this.heightBase = data.heightBase;
      if (data.heightFalloff !== undefined) this.heightFalloff = data.heightFalloff;
      if (data.extinctionCoeff !== undefined) this.extinctionCoeff = data.extinctionCoeff;
      if (data.scatterColor !== undefined) this.scatterColor = data.scatterColor;
      if (data.numSteps !== undefined) this.numSteps = data.numSteps;
      if (data.fogNear !== undefined) this.fogNear = data.fogNear;
      if (data.fogFar !== undefined) this.fogFar = data.fogFar;
      if (data.ambientColor !== undefined) this.ambientColor = data.ambientColor;
      if (data.ambientStrength !== undefined) this.ambientStrength = data.ambientStrength;
      if (data.lateralScatterStrength !== undefined)
        this.lateralScatterStrength = data.lateralScatterStrength;
      if (data.scatterStrength !== undefined) this.scatterStrength = data.scatterStrength;
    }

    this.mesh = await Mesh.getAsync('fullscreenquad.obj');
    this.raymarchTech = await Technique.getAsync('post-processing/fog_scatter_raymarch.tech');
    this.bilateralBlurTech = await Technique.getAsync('post-processing/fog_bilateral_blur.tech');
    this.composeTech = await Technique.getAsync('post-processing/fog_scatter_compose.tech');
    this.blueNoiseTexture = await Texture.getAsync('bluenoise64.png');

    this.createRenderTargets();
    this.createUniformBuffers();
    this.createStaticBindGroups();

    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'fog_scatter', (comp) => {
      const c = comp as FogScatterComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;
    this.destroyRenderTargets();
    this.createRenderTargets();
    this.csmBindGroup = null;
    this.cachedShadowView = null;
    this.blurDepthBG = null;
    this.cachedDepthView = null;
    this.fogComposeBG = null;
    this.blurInputBGCache.clear();
    this.composeSceneBGCache.clear();
    this.createStaticBindGroups();
  }

  // ─── Per-frame render ─────────────────────────────────────────────────────────

  public render(
    sceneView: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    dirLight: DirectionalLightComponent,
  ): GPUTextureView {
    if (!this.loaded) return sceneView;

    this.updateFogParamsBuffer();
    this.updateComposeParamsBuffer();

    const csmBG = this.getOrCreateCSMBindGroup(dirLight);
    if (!csmBG) return sceneView;

    const cameraBG = Engine.getRender().getMainCameraBindGroup();
    const depthBG = this.getOrRebuildBlurDepthBG();

    this.executePass('Fog Scatter Raymarch', this.raymarchTech, this.fogHalfRT, 1.0, [
      cameraBG,
      gBufferBindGroup,
      csmBG,
      this.fogParamsBindGroup!,
    ]);

    this.executePass('Fog Bilateral H', this.bilateralBlurTech, this.fogHalfBlurH, 1.0, [
      this.getOrCreateBlurInputBG(this.fogHalfRT.getView()),
      depthBG,
      this.fogBlurHBG,
    ]);

    this.executePass('Fog Bilateral V', this.bilateralBlurTech, this.fogHalfBlurred, 1.0, [
      this.getOrCreateBlurInputBG(this.fogHalfBlurH.getView()),
      depthBG,
      this.fogBlurVBG,
    ]);

    this.executePass('Scene Bilateral H', this.bilateralBlurTech, this.sceneBlurH, 1.0, [
      this.getOrCreateBlurInputBG(sceneView),
      depthBG,
      this.sceneBlurHBG,
    ]);

    this.executePass('Scene Bilateral V', this.bilateralBlurTech, this.sceneBlurred, 1.0, [
      this.getOrCreateBlurInputBG(this.sceneBlurH.getView()),
      depthBG,
      this.sceneBlurVBG,
    ]);

    this.executePass('Fog Compose', this.composeTech, this.resultRT, 1.0, [
      this.getOrCreateComposeBG(sceneView),
      this.fogComposeBG!,
      this.composeParamsBindGroup!,
    ]);

    return this.resultRT.getView();
  }

  public isEnabled(): boolean {
    return this._enabled;
  }
  public hasLoaded(): boolean {
    return this.loaded;
  }
  public override update(_dt: number): void {}
  public override renderDebug(): void {}

  public override renderInMenu(folder?: any): void {
    if (!folder || this._editorFolder) return;
    this._editorFolder = folder.addFolder('Fog Scatter');
    this._editorFolder.close();
    this._editorFolder.add(this, '_enabled').name('Enable').listen();
    this._editorFolder.add(this, 'density', 0.0, 0.1, 0.001).name('Density').listen();
    this._editorFolder.add(this, 'heightBase', -50, 50, 0.5).name('Height Base').listen();
    this._editorFolder.add(this, 'heightFalloff', 0.0, 0.5, 0.005).name('Height Falloff').listen();
    this._editorFolder.add(this, 'extinctionCoeff', 0.0, 0.1, 0.001).name('Extinction').listen();
    this._editorFolder.add(this, 'numSteps', [8, 16, 32]).name('Steps').listen();
    this._editorFolder.add(this, 'fogFar', 50, 2000, 10).name('Fog Far').listen();
    this._editorFolder
      .add(this, 'ambientStrength', 0.0, 1.0, 0.01)
      .name('Ambient Strength')
      .listen();
    this._editorFolder
      .add(this, 'lateralScatterStrength', 0.0, 1.0, 0.01)
      .name('Lateral Scatter')
      .listen();
    this._editorFolder
      .add(this, 'scatterStrength', 0.0, 1.0, 0.01)
      .name('Scatter Strength')
      .listen();
  }

  public override dispose(): void {
    this.fogParamsBuffer?.destroy();
    this.composeParamsBuffer?.destroy();
    this.fogBlurHBuffer?.destroy();
    this.fogBlurVBuffer?.destroy();
    this.sceneBlurHBuffer?.destroy();
    this.sceneBlurVBuffer?.destroy();
    this.destroyRenderTargets();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  private createRenderTargets(): void {
    const w = Render.width;
    const h = Render.height;
    const fmt: GPUTextureFormat = 'rgba16float';
    const halfW = Math.max(1, w >> 1);
    const halfH = Math.max(1, h >> 1);
    const qW = Math.max(1, w >> 2);
    const qH = Math.max(1, h >> 2);

    this.fogHalfRT = new RenderTarget();
    this.fogHalfRT.createRT('fog_half_rt', halfW, halfH, fmt);
    this.fogHalfBlurH = new RenderTarget();
    this.fogHalfBlurH.createRT('fog_half_blur_h', halfW, halfH, fmt);
    this.fogHalfBlurred = new RenderTarget();
    this.fogHalfBlurred.createRT('fog_half_blurred', halfW, halfH, fmt);
    this.sceneBlurH = new RenderTarget();
    this.sceneBlurH.createRT('fog_scene_blur_h', qW, qH, fmt);
    this.sceneBlurred = new RenderTarget();
    this.sceneBlurred.createRT('fog_scene_blurred', qW, qH, fmt);
    this.resultRT = new RenderTarget();
    this.resultRT.createRT('fog_result_rt', w, h, fmt);
  }

  private destroyRenderTargets(): void {
    this.fogHalfRT?.destroy();
    this.fogHalfBlurH?.destroy();
    this.fogHalfBlurred?.destroy();
    this.sceneBlurH?.destroy();
    this.sceneBlurred?.destroy();
    this.resultRT?.destroy();
  }

  private createUniformBuffers(): void {
    this.fogParamsBuffer = GPUUtils.createBuffer(
      'fog_scatter_params',
      64,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.composeParamsBuffer = GPUUtils.createBuffer(
      'fog_compose_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.fogBlurHBuffer = GPUUtils.createBuffer(
      'fog_blur_h_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.fogBlurVBuffer = GPUUtils.createBuffer(
      'fog_blur_v_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.sceneBlurHBuffer = GPUUtils.createBuffer(
      'scene_blur_h_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.sceneBlurVBuffer = GPUUtils.createBuffer(
      'scene_blur_v_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    GPUUtils.writeBuffer(this.fogBlurHBuffer, 0, new Float32Array([1, 0, 5.0, 2.0]));
    GPUUtils.writeBuffer(this.fogBlurVBuffer, 0, new Float32Array([0, 1, 5.0, 2.0]));
    GPUUtils.writeBuffer(this.sceneBlurHBuffer, 0, new Float32Array([1, 0, 1.0, 5.0]));
    GPUUtils.writeBuffer(this.sceneBlurVBuffer, 0, new Float32Array([0, 1, 1.0, 5.0]));
  }

  private createStaticBindGroups(): void {
    this.fogParamsBindGroup = BindGroupFactory.createBindGroup(
      'fog_scatter_params_bg',
      this.raymarchTech.getPipeline().getBindGroupLayout(3),
      [
        { binding: 0, resource: { buffer: this.fogParamsBuffer } },
        { binding: 1, resource: this.blueNoiseTexture.getTextureView()! },
        { binding: 2, resource: SamplerLibrary.simpleSampler! },
      ],
    );

    this.composeParamsBindGroup = BindGroupFactory.createBindGroup(
      'fog_compose_params_bg',
      this.composeTech.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.composeParamsBuffer } }],
    );

    this.fogComposeBG = BindGroupFactory.createBindGroup(
      'fog_compose_fog_bg',
      this.composeTech.getPipeline().getBindGroupLayout(1),
      [
        { binding: 0, resource: this.fogHalfRT.getView() },
        { binding: 1, resource: this.fogHalfBlurred.getView() },
        { binding: 2, resource: SamplerLibrary.simpleSampler! },
      ],
    );

    const blurParamsLayout = this.bilateralBlurTech.getPipeline().getBindGroupLayout(2);
    this.fogBlurHBG = BindGroupFactory.createBindGroup('fog_blur_h_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.fogBlurHBuffer } },
    ]);
    this.fogBlurVBG = BindGroupFactory.createBindGroup('fog_blur_v_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.fogBlurVBuffer } },
    ]);
    this.sceneBlurHBG = BindGroupFactory.createBindGroup('scene_blur_h_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.sceneBlurHBuffer } },
    ]);
    this.sceneBlurVBG = BindGroupFactory.createBindGroup('scene_blur_v_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.sceneBlurVBuffer } },
    ]);
  }

  private updateFogParamsBuffer(): void {
    const d = this.fogParamsData;
    d[0] = this.density;
    d[1] = this.heightBase;
    d[2] = this.heightFalloff;
    d[3] = Math.max(this.density, this.extinctionCoeff);
    d[4] = this.scatterColor[0];
    d[5] = this.scatterColor[1];
    d[6] = this.scatterColor[2];
    d[7] = Math.max(1, this.numSteps);
    d[8] = this.fogNear;
    d[9] = this.fogFar;
    d[10] = this._enabled ? 1.0 : 0.0;
    d[11] = 0;
    // ambientColor pre-scaled by globalFactor so the shader doesn't need to read it
    const globalFactor = Engine.getEnvironmentManager().getAmbientLightData().globalFactor;
    const ambientScale = this.ambientStrength * globalFactor;
    d[12] = this.ambientColor[0] * ambientScale;
    d[13] = this.ambientColor[1] * ambientScale;
    d[14] = this.ambientColor[2] * ambientScale;
    d[15] = 0;
    GPUUtils.writeBuffer(this.fogParamsBuffer, 0, d);
  }

  private updateComposeParamsBuffer(): void {
    const d = this.composeParamsData;
    d[0] = this.lateralScatterStrength;
    d[1] = this.scatterStrength;
    d[2] = this._enabled ? 1.0 : 0.0;
    d[3] = 0;
    GPUUtils.writeBuffer(this.composeParamsBuffer, 0, d);
  }

  private getOrCreateCSMBindGroup(dl: DirectionalLightComponent): GPUBindGroup | null {
    if (!dl.getHasShadows()) return null;
    const view0 = dl.getShadowDepthView(0);
    if (!view0) return null;
    if (view0 === this.cachedShadowView && this.csmBindGroup) return this.csmBindGroup;
    this.cachedShadowView = view0;
    const view1 = dl.getShadowDepthView(1) ?? view0;
    const view2 = dl.getShadowDepthView(2) ?? view0;
    this.csmBindGroup = BindGroupFactory.createBindGroup(
      'fog_csm_bg',
      this.raymarchTech.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: { buffer: dl.getUniformBuffer() } },
        { binding: 1, resource: view0 },
        { binding: 2, resource: view1 },
        { binding: 3, resource: view2 },
        { binding: 4, resource: dl.getShadowSampler() },
      ],
    );
    return this.csmBindGroup;
  }

  private getOrRebuildBlurDepthBG(): GPUBindGroup {
    const depthView = Engine.getRender().getDeferredRenderer().getLinearDepthView();
    if (depthView !== this.cachedDepthView || !this.blurDepthBG) {
      this.cachedDepthView = depthView;
      this.blurDepthBG = BindGroupFactory.createBindGroup(
        'fog_blur_depth_bg',
        this.bilateralBlurTech.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: depthView },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
        ],
      );
    }
    return this.blurDepthBG;
  }

  private getOrCreateBlurInputBG(view: GPUTextureView): GPUBindGroup {
    let bg = this.blurInputBGCache.get(view);
    if (!bg) {
      bg = BindGroupFactory.createBindGroup(
        'fog_blur_input_bg',
        this.bilateralBlurTech.getPipeline().getBindGroupLayout(0),
        [
          { binding: 0, resource: view },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
        ],
      );
      this.blurInputBGCache.set(view, bg);
    }
    return bg;
  }

  private getOrCreateComposeBG(sceneView: GPUTextureView): GPUBindGroup {
    let bg = this.composeSceneBGCache.get(sceneView);
    if (!bg) {
      bg = BindGroupFactory.createBindGroup(
        'fog_compose_scene_bg',
        this.composeTech.getPipeline().getBindGroupLayout(0),
        [
          { binding: 0, resource: sceneView },
          { binding: 1, resource: this.sceneBlurred.getView() },
          { binding: 2, resource: SamplerLibrary.simpleSampler! },
        ],
      );
      this.composeSceneBGCache.set(sceneView, bg);
    }
    return bg;
  }

  private executePass(
    label: string,
    technique: Technique,
    output: RenderTarget,
    clearAlpha: number,
    bindGroups: Array<GPUBindGroup | null>,
  ): void {
    const device = Render.getInstance().getDevice();
    const enc = device.createCommandEncoder({ label });
    const pass = enc.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: output.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: clearAlpha },
        },
      ],
    });
    pass.setPipeline(technique.getPipeline());
    for (let i = 0; i < bindGroups.length; i++) {
      const bg = bindGroups[i];
      if (bg) pass.setBindGroup(i, bg);
    }
    this.mesh.activate(pass);
    this.mesh.renderGroup(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
