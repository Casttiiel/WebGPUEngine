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
import { PointLightComponent } from './PointLightComponent';
import { SpotLightComponent } from './SpotLightComponent';

/**
 * FogScatterComponent — Screen-space volumetric fog with SSMS pyramid scatter.
 *
 * Pipeline (~14 passes):
 *   Pass 1    — fog_scatter_raymarch  → fogHalfRT        (half-res, Beer–Lambert)
 *   Pass 2    — bilateral blur H      → fogHalfBlurH
 *   Pass 3    — bilateral blur V      → fogHalfBlurred   (lateral scatter ready)
 *   Pass 4    — scatter prefilter     → scatterPrefilterRT  (scene × fog mask × blurTint)
 *   Pass 5–9  — kawase downsample     → scatterD[0..4]
 *   Pass 10–13— scatter upsample      → scatterU[0..3]   (SSMS two-input combine)
 *   Pass 14   — fog_scatter_compose   → resultRT         (final frame)
 *
 * FogScatterParams layout (80 bytes = 5 × 16):
 *   [0-3]   density, heightBase, heightFalloff, extinctionCoeff
 *   [4-7]   scatterColor.rgb (align 16), numSteps
 *   [8-11]  fogNear, fogFar, enabled, _pad1
 *   [12-15] noiseScale, noiseStrength, windOffsetX, windOffsetZ
 *   [16-19] fogBaseColor.rgb (align 16), noiseThreshold
 *
 * FogScatterComposeParams layout (32 bytes = 2 × 16):
 *   [0] maxDensity  [1] energyLoss  [2] scatterIntensity  [3] scatterRadius
 *   [4] enabled     [5-7] padding
 *
 * ScatterPrefilterParams layout (32 bytes = 2 × 16):
 *   [0-2] blurTint.rgb  [3] fadeCurve
 *   [4] threshold  [5] softKnee  [6-7] padding
 */
export class FogScatterComponent extends Component {
  // ─── Techniques + mesh ───────────────────────────────────────────────────────
  private raymarchTech!: Technique;
  private bilateralBlurTech!: Technique;
  private composeTech!: Technique;
  private prefilterTech!: Technique;
  private kawaseDownTech!: Technique;
  private scatterUpsampleTech!: Technique;
  private mesh!: Mesh;

  // ─── Render targets ───────────────────────────────────────────────────────────
  private fogHalfRT!: RenderTarget;
  private fogHalfBlurH!: RenderTarget;
  private fogHalfBlurred!: RenderTarget;
  private scatterPrefilterRT!: RenderTarget;
  private scatterD: RenderTarget[] = []; // downsample pyramid
  private scatterU: RenderTarget[] = []; // upsample pyramid
  private resultRT!: RenderTarget;

  // ─── Uniform buffers ──────────────────────────────────────────────────────────
  private fogParamsBuffer!: GPUBuffer; // FogScatterParams (80 bytes)
  private composeParamsBuffer!: GPUBuffer; // FogScatterComposeParams (32 bytes)
  private fogBlurHBuffer!: GPUBuffer; // bilateral blur H (16 bytes)
  private fogBlurVBuffer!: GPUBuffer; // bilateral blur V (16 bytes)
  private prefilterParamsBuffer!: GPUBuffer; // ScatterPrefilterParams (32 bytes)
  private kawaseUniformBuffer!: GPUBuffer; // kawase downsample uniform (16 bytes)
  private scatterUpsampleParamsBuffer!: GPUBuffer; // ScatterUpsampleParams (16 bytes)

  // ─── Bind groups ──────────────────────────────────────────────────────────────
  private fogParamsBindGroup: GPUBindGroup | null = null;
  private composeParamsBG: GPUBindGroup | null = null;
  private fogComposeBG: GPUBindGroup | null = null; // fogHalfBlurred for compose + prefilter
  private blurDepthBG: GPUBindGroup | null = null;
  private cachedDepthView: GPUTextureView | null = null;
  private fogBlurHBG!: GPUBindGroup;
  private fogBlurVBG!: GPUBindGroup;
  private kawaseUniformBG: GPUBindGroup | null = null;
  private prefilterParamsBG: GPUBindGroup | null = null;
  private scatterUpsampleParamsBG: GPUBindGroup | null = null;
  private csmBindGroup: GPUBindGroup | null = null;
  private cachedShadowView: GPUTextureView | null = null;

  // Single-texture BG cache shared across all passes that need (texture + sampler)
  private singleTexBGCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ─── Blue noise ───────────────────────────────────────────────────────────────
  private blueNoiseTexture!: Texture;

  // ─── Raymarch params ──────────────────────────────────────────────────────────
  private _enabled: boolean = true;
  public density: number = 0.012;
  public heightBase: number = 0.0;
  public heightFalloff: number = 0.08;
  public extinctionCoeff: number = 0.015;
  public scatterColor: [number, number, number] = [0.85, 0.92, 1.0];
  public numSteps: number = 16;
  public fogNear: number = 0.0;
  public fogFar: number = 500.0;
  // Fog bilateral blur (removes blue noise from raymarch)
  public fogBlurRadius: number = 3.0;
  public fogDepthSigma: number = 50.0;
  // Spatial density noise
  public noiseScale: number = 0.1;
  public noiseStrength: number = 0.5;
  public windSpeed: number = 0.02;
  public windAngle: number = 45.0;
  public fogBaseColor: [number, number, number] = [1.0, 1.0, 1.0];
  public noiseThreshold: number = 0.3;

  // ─── SSMS pyramid params ──────────────────────────────────────────────────────
  public maxDensity: number = 0.95; // max fog opacity
  public energyLoss: number = 0.0; // scene darkening in fog
  public blurTint: [number, number, number] = [1.0, 1.0, 1.0]; // scatter tint color
  public blurWeight: number = 1.0; // pyramid amplification
  public scatterIntensity: number = 0.8; // final blend strength
  public scatterRadius: number = 4.0; // pyramid brightness normalisation
  public fadeCurve: number = 0.3; // fog-depth remap exponent
  public threshold: number = 0.0; // brightness threshold
  public softKnee: number = 0.5; // threshold knee width

  // Wind accumulation (updated each tick)
  private windX: number = 0;
  private windZ: number = 0;

  private loaded = false;
  private readonly fogParamsData = new Float32Array(20); // 80 bytes
  private readonly composeParamsData = new Float32Array(8); // 32 bytes
  private readonly blurParamsTemp = new Float32Array(4); // 16 bytes
  private readonly prefilterParamsData = new Float32Array(8); // 32 bytes
  private readonly kawaseData = new Float32Array(4); // 16 bytes
  private readonly upsampleParamsData = new Float32Array(4); // 16 bytes


  private static readonly NUM_PYRAMID = 5;

  // ─── Fog lights (point + spot, evaluated per raymarch step) ──────────────────
  private static readonly MAX_FOG_POINT_LIGHTS = 32;
  private static readonly MAX_FOG_SPOT_LIGHTS  = 16;
  private static readonly POINT_FLOATS = 12; // PointLightEntry = 3 × vec4
  private static readonly SPOT_FLOATS  = 16; // SpotLightEntry  = 4 × vec4

  private fogLightCountBuffer!: GPUBuffer;
  private fogPointLightBuffer!: GPUBuffer;
  private fogSpotLightBuffer!:  GPUBuffer;

  private fogLightCountData = new Uint32Array(4);
  private readonly fogPointLightData = new Float32Array(
    FogScatterComponent.MAX_FOG_POINT_LIGHTS * FogScatterComponent.POINT_FLOATS,
  );
  private readonly fogSpotLightData = new Float32Array(
    FogScatterComponent.MAX_FOG_SPOT_LIGHTS * FogScatterComponent.SPOT_FLOATS,
  );

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
      if (data.fogBlurRadius !== undefined) this.fogBlurRadius = data.fogBlurRadius;
      if (data.fogDepthSigma !== undefined) this.fogDepthSigma = data.fogDepthSigma;
      if (data.noiseScale !== undefined) this.noiseScale = data.noiseScale;
      if (data.noiseStrength !== undefined) this.noiseStrength = data.noiseStrength;
      if (data.windSpeed !== undefined) this.windSpeed = data.windSpeed;
      if (data.windAngle !== undefined) this.windAngle = data.windAngle;
      if (data.fogBaseColor !== undefined) this.fogBaseColor = data.fogBaseColor;
      if (data.noiseThreshold !== undefined) this.noiseThreshold = data.noiseThreshold;
      if (data.maxDensity !== undefined) this.maxDensity = data.maxDensity;
      if (data.energyLoss !== undefined) this.energyLoss = data.energyLoss;
      if (data.blurTint !== undefined) this.blurTint = data.blurTint;
      if (data.blurWeight !== undefined) this.blurWeight = data.blurWeight;
      if (data.scatterIntensity !== undefined) this.scatterIntensity = data.scatterIntensity;
      if (data.scatterRadius !== undefined) this.scatterRadius = data.scatterRadius;
      if (data.fadeCurve !== undefined) this.fadeCurve = data.fadeCurve;
      if (data.threshold !== undefined) this.threshold = data.threshold;
      if (data.softKnee !== undefined) this.softKnee = data.softKnee;
    }

    this.mesh = await Mesh.getAsync('fullscreenquad.obj');
    this.raymarchTech = await Technique.getAsync('post-processing/fog_scatter_raymarch.tech');
    this.bilateralBlurTech = await Technique.getAsync('post-processing/fog_bilateral_blur.tech');
    this.composeTech = await Technique.getAsync('post-processing/fog_scatter_compose.tech');
    this.prefilterTech = await Technique.getAsync('post-processing/fog_scatter_prefilter.tech');
    this.kawaseDownTech = await Technique.getAsync('post-processing/kawase_downsample.tech');
    this.scatterUpsampleTech = await Technique.getAsync(
      'post-processing/fog_scatter_scatter_upsample.tech',
    );
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
    this.singleTexBGCache.clear();
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
    this.updateBlurBuffers();
    this.updatePrefilterParamsBuffer();
    this.updateUpsampleParamsBuffer();

    const csmBG = this.getOrCreateCSMBindGroup(dirLight);
    if (!csmBG) return sceneView;

    const cameraBG = Engine.getRender().getMainCameraBindGroup();
    const depthBG = this.getOrRebuildBlurDepthBG();

    this.prepareFogLights();

    // Pass 1: Raymarch → fogHalfRT
    this.executePass('Fog Scatter Raymarch', this.raymarchTech, this.fogHalfRT, 1.0, false, [
      cameraBG,
      gBufferBindGroup,
      csmBG,
      this.fogParamsBindGroup!,
    ]);

    // Pass 2: Fog Bilateral H → fogHalfBlurH
    this.executePass('Fog Bilateral H', this.bilateralBlurTech, this.fogHalfBlurH, 1.0, false, [
      this.getOrCreateSingleTexBG(this.fogHalfRT.getView()),
      depthBG,
      this.fogBlurHBG,
    ]);

    // Pass 3: Fog Bilateral V → fogHalfBlurred
    this.executePass('Fog Bilateral V', this.bilateralBlurTech, this.fogHalfBlurred, 1.0, false, [
      this.getOrCreateSingleTexBG(this.fogHalfBlurH.getView()),
      depthBG,
      this.fogBlurVBG,
    ]);

    // Pass 4: SSMS prefilter → scatterPrefilterRT
    this.executePass('Scatter Prefilter', this.prefilterTech, this.scatterPrefilterRT, 0.0, false, [
      this.getOrCreateSingleTexBG(sceneView),
      this.fogComposeBG!,
      this.prefilterParamsBG!,
    ]);

    // Passes 5–9: Downsample pyramid
    let currentInput = this.scatterPrefilterRT.getView();
    for (let i = 0; i < this.scatterD.length; i++) {
      const dRT = this.scatterD[i]!;
      this.executePass(`Scatter Down ${i}`, this.kawaseDownTech, dRT, 0.0, false, [
        this.getOrCreateSingleTexBG(currentInput),
        this.kawaseUniformBG!,
      ]);
      currentInput = dRT.getView();
    }

    // Passes 10–13: Upsample pyramid (two-input SSMS combine)
    // currentInput = scatterD[last] (coarsest), going back toward D[0]
    for (let i = this.scatterD.length - 2; i >= 0; i--) {
      const uRT = this.scatterU[i]!;
      const dBase = this.scatterD[i]!;
      this.executePass(`Scatter Up ${i}`, this.scatterUpsampleTech, uRT, 0.0, false, [
        this.getOrCreateSingleTexBG(currentInput), // group 0: coarser (main)
        this.getOrCreateSingleTexBG(dBase.getView()), // group 1: base (finer D)
        this.scatterUpsampleParamsBG!,
      ]);
      currentInput = uRT.getView();
    }

    // Pass 14: Compose
    this.executePass('Fog Compose', this.composeTech, this.resultRT, 1.0, false, [
      this.getOrCreateSingleTexBG(sceneView), // group 0: scene
      this.fogComposeBG!, // group 1: fogHalfBlurred
      this.getOrCreateSingleTexBG(currentInput), // group 2: scatter U[0]
      this.composeParamsBG!, // group 3: compose params
    ]);

    return this.resultRT.getView();
  }

  public isEnabled(): boolean {
    return this._enabled;
  }
  public hasLoaded(): boolean {
    return this.loaded;
  }
  public override update(dt: number): void {
    if (!this.loaded) return;
    const rad = this.windAngle * (Math.PI / 180.0);
    this.windX += Math.cos(rad) * this.windSpeed * dt;
    this.windZ += Math.sin(rad) * this.windSpeed * dt;
  }
  public override renderDebug(): void {}

  public override renderInMenu(folder?: any): void {
    if (!folder || this._editorFolder) return;
    this._editorFolder = folder.addFolder('Fog Scatter');
    this._editorFolder.close();
    this._editorFolder.add(this, '_enabled').name('Enable').listen();

    // Fog intensity + reach
    this._editorFolder.add(this, 'density', 0.0, 0.05, 0.00005).name('Density').listen();
    this._editorFolder.add(this, 'fogFar', 50, 2000, 10).name('Fog Far').listen();

    // Height
    this._editorFolder.add(this, 'heightBase', -50, 50, 0.5).name('Height Base').listen();
    this._editorFolder.add(this, 'heightFalloff', 0.0, 0.5, 0.005).name('Height Falloff').listen();

    // Noise
    this._editorFolder.add(this, 'noiseScale', 0.01, 0.5, 0.01).name('Noise Scale').listen();
    this._editorFolder.add(this, 'noiseStrength', 0.0, 1.0, 0.01).name('Noise Strength').listen();
    this._editorFolder.add(this, 'noiseThreshold', 0.0, 0.9, 0.01).name('Noise Threshold').listen();

    // Scatter blur — intensity, when it kicks in, spread
    this._editorFolder
      .add(this, 'scatterIntensity', 0.0, 1.0, 0.01)
      .name('Scatter Intensity')
      .listen();
    this._editorFolder.add(this, 'fadeCurve', 0.1, 4.0, 0.1).name('Scatter Depth Curve').listen();
    this._editorFolder.add(this, 'blurWeight', 0.1, 10.0, 0.1).name('Scatter Spread').listen();
  }

  public override dispose(): void {
    this.fogParamsBuffer?.destroy();
    this.composeParamsBuffer?.destroy();
    this.fogBlurHBuffer?.destroy();
    this.fogBlurVBuffer?.destroy();
    this.prefilterParamsBuffer?.destroy();
    this.kawaseUniformBuffer?.destroy();
    this.scatterUpsampleParamsBuffer?.destroy();
    this.fogLightCountBuffer?.destroy();
    this.fogPointLightBuffer?.destroy();
    this.fogSpotLightBuffer?.destroy();
    this.destroyRenderTargets();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  private createRenderTargets(): void {
    const w = Render.width;
    const h = Render.height;
    const fmt: GPUTextureFormat = 'rgba16float';
    const halfW = Math.max(1, w >> 1);
    const halfH = Math.max(1, h >> 1);

    this.fogHalfRT = new RenderTarget();
    this.fogHalfRT.createRT('fog_half_rt', halfW, halfH, fmt);
    this.fogHalfBlurH = new RenderTarget();
    this.fogHalfBlurH.createRT('fog_half_blur_h', halfW, halfH, fmt);
    this.fogHalfBlurred = new RenderTarget();
    this.fogHalfBlurred.createRT('fog_half_blurred', halfW, halfH, fmt);

    this.scatterPrefilterRT = new RenderTarget();
    this.scatterPrefilterRT.createRT('fog_scatter_prefilter', w, h, fmt);

    this.scatterD = [];
    let dw = w;
    let dh = h;
    for (let i = 0; i < FogScatterComponent.NUM_PYRAMID; i++) {
      dw = Math.max(1, dw >> 1);
      dh = Math.max(1, dh >> 1);
      const rt = new RenderTarget();
      rt.createRT(`fog_scatter_d${i}`, dw, dh, fmt);
      this.scatterD.push(rt);
    }

    this.scatterU = [];
    dw = w;
    dh = h;
    for (let i = 0; i < FogScatterComponent.NUM_PYRAMID - 1; i++) {
      dw = Math.max(1, dw >> 1);
      dh = Math.max(1, dh >> 1);
      const rt = new RenderTarget();
      rt.createRT(`fog_scatter_u${i}`, dw, dh, fmt);
      this.scatterU.push(rt);
    }

    this.resultRT = new RenderTarget();
    this.resultRT.createRT('fog_result_rt', w, h, fmt);
  }

  private destroyRenderTargets(): void {
    this.fogHalfRT?.destroy();
    this.fogHalfBlurH?.destroy();
    this.fogHalfBlurred?.destroy();
    this.scatterPrefilterRT?.destroy();
    this.scatterD.forEach((rt) => rt.destroy());
    this.scatterD = [];
    this.scatterU.forEach((rt) => rt.destroy());
    this.scatterU = [];
    this.resultRT?.destroy();
  }

  private createUniformBuffers(): void {
    this.fogParamsBuffer = GPUUtils.createBuffer(
      'fog_scatter_params',
      80,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.composeParamsBuffer = GPUUtils.createBuffer(
      'fog_compose_params',
      32,
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
    this.prefilterParamsBuffer = GPUUtils.createBuffer(
      'fog_prefilter_params',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.kawaseUniformBuffer = GPUUtils.createBuffer(
      'fog_kawase_uniform',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.scatterUpsampleParamsBuffer = GPUUtils.createBuffer(
      'fog_scatter_upsample_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const MP = FogScatterComponent.MAX_FOG_POINT_LIGHTS;
    const MS = FogScatterComponent.MAX_FOG_SPOT_LIGHTS;
    const PF = FogScatterComponent.POINT_FLOATS;
    const SF = FogScatterComponent.SPOT_FLOATS;
    this.fogLightCountBuffer = GPUUtils.createBuffer('fog_light_counts', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.fogPointLightBuffer = GPUUtils.createBuffer('fog_point_lights', MP * PF * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.fogSpotLightBuffer  = GPUUtils.createBuffer('fog_spot_lights',  MS * SF * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  }

  private createStaticBindGroups(): void {
    // Group 3: fog params + blue noise + light data (counts / point / spot) — all in one group
    // because WebGPU caps at 4 bind groups (0–3) per pipeline.
    this.fogParamsBindGroup = BindGroupFactory.createBindGroup(
      'fog_scatter_params_bg',
      this.raymarchTech.getPipeline().getBindGroupLayout(3),
      [
        { binding: 0, resource: { buffer: this.fogParamsBuffer } },
        { binding: 1, resource: this.blueNoiseTexture.getTextureView()! },
        { binding: 2, resource: SamplerLibrary.simpleSampler! },
        { binding: 3, resource: { buffer: this.fogLightCountBuffer } },
        { binding: 4, resource: { buffer: this.fogPointLightBuffer } },
        { binding: 5, resource: { buffer: this.fogSpotLightBuffer } },
      ],
    );

    // fogHalfBlurred bind group: shared by compose (group 1) and prefilter (group 1)
    this.fogComposeBG = BindGroupFactory.createBindGroup(
      'fog_compose_fog_bg',
      BindGroupFactory.getFogScatterFogTexturesLayout(),
      [
        { binding: 0, resource: this.fogHalfBlurred.getView() },
        { binding: 1, resource: SamplerLibrary.simpleSampler! },
      ],
    );

    this.composeParamsBG = BindGroupFactory.createBindGroup(
      'fog_compose_params_bg',
      this.composeTech.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.composeParamsBuffer } }],
    );

    const blurParamsLayout = this.bilateralBlurTech.getPipeline().getBindGroupLayout(2);
    this.fogBlurHBG = BindGroupFactory.createBindGroup('fog_blur_h_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.fogBlurHBuffer } },
    ]);
    this.fogBlurVBG = BindGroupFactory.createBindGroup('fog_blur_v_bg', blurParamsLayout, [
      { binding: 0, resource: { buffer: this.fogBlurVBuffer } },
    ]);

    this.kawaseUniformBG = BindGroupFactory.createBindGroup(
      'fog_kawase_uniform_bg',
      this.kawaseDownTech.getPipeline().getBindGroupLayout(1),
      [{ binding: 0, resource: { buffer: this.kawaseUniformBuffer } }],
    );

    this.prefilterParamsBG = BindGroupFactory.createBindGroup(
      'fog_prefilter_params_bg',
      this.prefilterTech.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.prefilterParamsBuffer } }],
    );

    this.scatterUpsampleParamsBG = BindGroupFactory.createBindGroup(
      'fog_scatter_upsample_params_bg',
      this.scatterUpsampleTech.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.scatterUpsampleParamsBuffer } }],
    );
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
    d[11] = 0.0; // _pad1
    d[12] = this.noiseScale;
    d[13] = this.noiseStrength;
    d[14] = this.windX;
    d[15] = this.windZ;
    d[16] = this.fogBaseColor[0];
    d[17] = this.fogBaseColor[1];
    d[18] = this.fogBaseColor[2];
    d[19] = this.noiseThreshold;
    GPUUtils.writeBuffer(this.fogParamsBuffer, 0, d);
  }

  private updateComposeParamsBuffer(): void {
    const d = this.composeParamsData;
    d[0] = this.maxDensity;
    d[1] = this.energyLoss;
    d[2] = this.scatterIntensity;
    d[3] = this.scatterRadius;
    d[4] = this._enabled ? 1.0 : 0.0;
    d[5] = 0;
    d[6] = 0;
    d[7] = 0;
    GPUUtils.writeBuffer(this.composeParamsBuffer, 0, d);
  }

  private updateBlurBuffers(): void {
    const t = this.blurParamsTemp;
    t[0] = 1;
    t[1] = 0;
    t[2] = this.fogDepthSigma;
    t[3] = this.fogBlurRadius;
    GPUUtils.writeBuffer(this.fogBlurHBuffer, 0, t);
    t[0] = 0;
    t[1] = 1;
    GPUUtils.writeBuffer(this.fogBlurVBuffer, 0, t);
  }

  private updatePrefilterParamsBuffer(): void {
    const d = this.prefilterParamsData;
    d[0] = this.blurTint[0];
    d[1] = this.blurTint[1];
    d[2] = this.blurTint[2];
    d[3] = this.fadeCurve;
    d[4] = this.threshold;
    d[5] = this.softKnee;
    d[6] = 0;
    d[7] = 0;
    GPUUtils.writeBuffer(this.prefilterParamsBuffer, 0, d);
  }

  private updateUpsampleParamsBuffer(): void {
    this.upsampleParamsData[0] = this.blurWeight;
    this.upsampleParamsData[1] = 0;
    this.upsampleParamsData[2] = 0;
    this.upsampleParamsData[3] = 0;
    GPUUtils.writeBuffer(this.scatterUpsampleParamsBuffer, 0, this.upsampleParamsData);
    // kawase downsample buffer just needs a valid 16-byte write (values unused)
    this.kawaseData[0] = 1.0;
    GPUUtils.writeBuffer(this.kawaseUniformBuffer, 0, this.kawaseData);
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

  private getOrCreateSingleTexBG(view: GPUTextureView): GPUBindGroup {
    let bg = this.singleTexBGCache.get(view);
    if (!bg) {
      bg = BindGroupFactory.createBindGroup(
        'fog_single_tex_bg',
        BindGroupFactory.getSingleTextureLayout(),
        [
          { binding: 0, resource: view },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
        ],
      );
      this.singleTexBGCache.set(view, bg);
    }
    return bg;
  }

  private prepareFogLights(): void {
    const MP = FogScatterComponent.MAX_FOG_POINT_LIGHTS;
    const MS = FogScatterComponent.MAX_FOG_SPOT_LIGHTS;
    const PF = FogScatterComponent.POINT_FLOATS;
    const SF = FogScatterComponent.SPOT_FLOATS;
    let pc = 0;
    let sc = 0;

    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ?? []) {
      const pl = comp as PointLightComponent;
      if (!pl.isVisible() || pc >= MP) continue;
      const o = pc * PF;
      const pos = pl.getWorldPosition();
      const col = pl.getColor();
      this.fogPointLightData[o + 0] = col[0];  this.fogPointLightData[o + 1] = col[1];
      this.fogPointLightData[o + 2] = col[2];  this.fogPointLightData[o + 3] = pl.getIntensity();
      this.fogPointLightData[o + 4] = pos[0];  this.fogPointLightData[o + 5] = pos[1];
      this.fogPointLightData[o + 6] = pos[2];  this.fogPointLightData[o + 7] = pl.getRadius();
      this.fogPointLightData[o + 8] = pl.getStartFalloff();
      pc++;
    }

    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const sl = comp as SpotLightComponent;
      if (!sl.isVisible() || sc >= MS) continue;
      const o = sc * SF;
      const cam = sl.getCamera();
      const pos = cam.getPosition();
      const dir = cam.getFront();
      const col = sl.getColor();
      this.fogSpotLightData[o + 0]  = col[0]; this.fogSpotLightData[o + 1]  = col[1];
      this.fogSpotLightData[o + 2]  = col[2]; this.fogSpotLightData[o + 3]  = sl.getIntensity();
      this.fogSpotLightData[o + 4]  = pos[0]; this.fogSpotLightData[o + 5]  = pos[1];
      this.fogSpotLightData[o + 6]  = pos[2]; this.fogSpotLightData[o + 7]  = sl.getRadius();
      this.fogSpotLightData[o + 8]  = sl.getStartFalloff();
      // o+9..o+11: pad (already zero)
      this.fogSpotLightData[o + 12] = dir[0]; this.fogSpotLightData[o + 13] = dir[1];
      this.fogSpotLightData[o + 14] = dir[2]; this.fogSpotLightData[o + 15] = Math.cos(cam.getFov() * 0.5);
      sc++;
    }

    this.fogLightCountData[0] = pc;
    this.fogLightCountData[1] = sc;
    this.fogLightCountData[2] = 0;
    this.fogLightCountData[3] = 0;
    GPUUtils.writeBuffer(this.fogLightCountBuffer, 0, this.fogLightCountData);
    if (pc > 0) GPUUtils.writeBuffer(this.fogPointLightBuffer, 0, this.fogPointLightData.subarray(0, pc * PF));
    if (sc > 0) GPUUtils.writeBuffer(this.fogSpotLightBuffer,  0, this.fogSpotLightData.subarray(0, sc * SF));
  }

  private executePass(
    label: string,
    technique: Technique,
    output: RenderTarget,
    clearAlpha: number,
    _loadOp: boolean,
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
