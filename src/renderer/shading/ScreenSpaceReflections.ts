import { Logger } from '../../core/debug/Logger';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { RenderTarget } from '../resources/RenderTarget';
import { Texture } from '../resources/Texture';
import { GPUProfiler } from '../../core/debug/GPUProfiler';

export class ScreenSpaceReflections {
  private isInitialized: boolean = false;
  private _editorFolder: any = null;

  // ── SSR ray-march compute ────────────────────────────────────────────────
  private ssrComputePipeline: GPUComputePipeline | null = null;
  private ssrParamsLayout: GPUBindGroupLayout | null = null;
  private ssrOutputLayout: GPUBindGroupLayout | null = null;

  // ── Hi-Z depth pyramid ────────────────────────────────────────────────────
  // hizTex has HIZ_LEVELS mip levels at half-render-resolution base size.
  // Level 0 of the pyramid = gLinearDepth (read directly in the shader).
  // hizTex mip k = full-pyramid level (k+1), built by min-pooling each frame.
  private static readonly HIZ_LEVELS = 4;
  private hizTexture: GPUTexture | null = null;
  private hizReadView: GPUTextureView | null = null;   // all mip levels — bound in SSR
  private hizMipViews: GPUTextureView[] = [];           // one per mip level — build passes
  private hizBuildPipelineL0: GPUComputePipeline | null = null; // src: filterable (gLinearDepth)
  private hizBuildPipelineL1: GPUComputePipeline | null = null; // src: unfilterable (hizTex)
  private hizBuildL0BG: GPUBindGroup | null = null;    // gLinearDepth → hizTex mip 0
  private hizBuildL1BGs: GPUBindGroup[] = [];           // hizTex mip k → mip k+1 (3 groups)
  private lastHiZDepthView: GPUTextureView | null = null; // cache key for L0 bind group

  // ── Blur compute ─────────────────────────────────────────────────────────
  private blurPipeline: GPUComputePipeline | null = null;
  private blurInputLayout: GPUBindGroupLayout | null = null;
  private blurGBufferLayout: GPUBindGroupLayout | null = null;
  private blurOutputLayout: GPUBindGroupLayout | null = null;
  private blurInputBindGroup: GPUBindGroup | null = null;
  private blurGBufferBindGroup: GPUBindGroup | null = null;
  private blurOutputBindGroup: GPUBindGroup | null = null;
  // Cached GBuffer views used for blur — invalidate when they change
  private lastBlurNormalsView: GPUTextureView | null = null;
  private lastBlurDepthView: GPUTextureView | null = null;

  // ── Render targets ───────────────────────────────────────────────────────
  /** Raw march output — written by ssr.cs, read by ssr_blur.cs */
  private ssrResult!: RenderTarget;
  /** Blurred output — read by ambient_specular.fs */
  private ssrBlurred!: RenderTarget;

  // ── Bind groups ──────────────────────────────────────────────────────────
  private ssrBindGroup: GPUBindGroup | null = null;
  private ssrOutputBindGroup: GPUBindGroup | null = null;
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;
  /** Tracks which texture view is bound as the SSR color source.
   *  When it changes (e.g. switch between accLight and TAA history after resize
   *  or on first valid history frame) the bind group must be rebuilt. */
  private lastAccLightsView: GPUTextureView | null = null;

  // ── Buffers / textures ────────────────────────────────────────────────────
  private ssrUniformBuffer!: GPUBuffer;
  private brdfLUT!: Texture;
  private blueNoiseTexture!: Texture;
  /** Incremented every frame — drives blue-noise temporal animation in ssr.cs */
  private frameIndex: number = 0;

  // ── Debug-tweakable parameters (exposed in renderInMenu) ─────────────────
  private debugParams = {
    stepSize: 0.3,
    maxSteps: 48,
    maxDistance: 300.0,
    thickness: 0.03,
    metallicMin: 0.4,
    roughnessMax: 0.6,
    enabled: 1.0,
    temporalMode: 0.0, // set externally by DeferredRenderer when TAA is active
  };

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.isInitialized = true;
      this.brdfLUT = await Texture.getAsync('brdfLUT.png');
      this.blueNoiseTexture = await Texture.getAsync('bluenoise64.png');

      this.createRenderTarget();

      const qs2 = QualitySettings.getInstance().getSettings();
      this.debugParams.stepSize = qs2.ssrStepSize;
      this.debugParams.maxSteps = qs2.ssrMaxSteps;

      this.ssrUniformBuffer = GPUUtils.createBuffer(
        'ssr uniform buffer',
        48,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      await this.createComputePipeline();
      await this.createBlurPipeline();
      await this.createHiZBuildPipelines();

      Logger.info('RENDER', 'SSR ready');
    } catch (error) {
      console.warn('Failed to load SSR, disabling feature:', error);
      this.isInitialized = false;
    }
  }

  private createRenderTarget(): void {
    const qs = QualitySettings.getInstance().getSettings();
    const w = Math.floor(Render.width * qs.ssrScale);
    const h = Math.floor(Render.height * qs.ssrScale);
    const fmt = qs.hdrTexture as GPUTextureFormat;

    if (!this.ssrResult) this.ssrResult = new RenderTarget();
    if (!this.ssrBlurred) this.ssrBlurred = new RenderTarget();

    // Raw march output — needs STORAGE_BINDING (written by compute) + TEXTURE_BINDING (read by blur)
    this.ssrResult.createRT('ssr_result.dds', w, h, fmt, GPUTextureUsage.STORAGE_BINDING);
    // Blurred output — also STORAGE_BINDING (blur writes) + TEXTURE_BINDING (ambient_specular reads)
    this.ssrBlurred.createRT('ssr_blurred.dds', w, h, fmt, GPUTextureUsage.STORAGE_BINDING);

    // Invalidate all bind groups that reference these textures
    this.ssrOutputBindGroup = null;
    this.blurInputBindGroup = null;
    this.blurOutputBindGroup = null;

    // Hi-Z pyramid is built from gLinearDepth (render resolution, not SSR scale).
    // Base size = half render resolution; HIZ_LEVELS mip levels give 1/2 → 1/16 res pyramid.
    this.createHiZTexture(Render.width, Render.height);
  }

  private createHiZTexture(renderW: number, renderH: number): void {
    if (this.hizTexture) {
      this.hizTexture.destroy();
      this.hizTexture = null;
    }

    const device = GPUUtils.getDevice();
    const baseW = Math.max(1, Math.ceil(renderW / 2));
    const baseH = Math.max(1, Math.ceil(renderH / 2));

    this.hizTexture = device.createTexture({
      label: 'hiz_texture',
      size: [baseW, baseH, 1],
      mipLevelCount: ScreenSpaceReflections.HIZ_LEVELS,
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    // Full read view (all mip levels) — bound as hizTex in the SSR march shader
    this.hizReadView = this.hizTexture.createView({ label: 'hiz_read_all' });

    // Per-mip views (single level each) — used as src/dst in the build passes.
    // Each view exposes only one mip so WebGPU sees no read/write overlap in a single pass.
    this.hizMipViews = [];
    for (let k = 0; k < ScreenSpaceReflections.HIZ_LEVELS; k++) {
      this.hizMipViews.push(
        this.hizTexture.createView({
          label: `hiz_mip_${k}`,
          baseMipLevel: k,
          mipLevelCount: 1,
        }),
      );
    }

    // Pre-build the inter-level bind groups (mip k → mip k+1).
    // These don't depend on gLinearDepth so they can be created immediately.
    this.hizBuildL1BGs = [];
    const unfilterLayout = BindGroupFactory.getHiZBuildFromUnfilterableLayout();
    for (let k = 0; k < ScreenSpaceReflections.HIZ_LEVELS - 1; k++) {
      this.hizBuildL1BGs.push(
        BindGroupFactory.createBindGroup(`hiz_build_l${k + 1}_bg`, unfilterLayout, [
          { binding: 0, resource: this.hizMipViews[k]! },     // src: mip k (read)
          { binding: 1, resource: this.hizMipViews[k + 1]! }, // dst: mip k+1 (write)
        ]),
      );
    }

    // Level-0 bind group depends on gLinearDepth — lazily created in executeHiZBuildPasses
    this.hizBuildL0BG = null;
    this.lastHiZDepthView = null;

    // SSR main bind group must be rebuilt (hizReadView changed)
    this.ssrBindGroup = null;
    this.lastAccLightsView = null;
  }

  private async createHiZBuildPipelines(): Promise<void> {
    const device = GPUUtils.getDevice();
    const shaderCode = await ResourceManager.loadShader('post-processing/hiz_build.cs');
    const module = device.createShaderModule({ label: 'hiz_build_cs', code: shaderCode });

    const l0Layout = BindGroupFactory.getHiZBuildFromFilterableLayout();
    const l1Layout = BindGroupFactory.getHiZBuildFromUnfilterableLayout();

    const l0Config: ComputePipelineConfig = {
      label: 'Hi-Z Build L0 Pipeline',
      layout: PipelineFactory.createPipelineLayout('hiz_build_l0_layout', [l0Layout]),
      compute: { module, entryPoint: 'cs' },
    };
    this.hizBuildPipelineL0 = PipelineFactory.createComputePipeline(l0Config);

    const l1Config: ComputePipelineConfig = {
      label: 'Hi-Z Build L1+ Pipeline',
      layout: PipelineFactory.createPipelineLayout('hiz_build_l1_layout', [l1Layout]),
      compute: { module, entryPoint: 'cs' },
    };
    this.hizBuildPipelineL1 = PipelineFactory.createComputePipeline(l1Config);
  }

  // ─── Compute pipeline setup ────────────────────────────────────────────────

  private async createBlurPipeline(): Promise<void> {
    const device = GPUUtils.getDevice();
    this.blurInputLayout = BindGroupFactory.getSSRBlurInputLayout();
    this.blurGBufferLayout = BindGroupFactory.getSSRBlurGBufferLayout();
    this.blurOutputLayout = BindGroupFactory.getSSRBlurOutputLayout();

    const shaderCode = await ResourceManager.loadShader('post-processing/ssr_blur.cs');
    const module = device.createShaderModule({ label: 'ssr_blur_cs', code: shaderCode });
    const config: ComputePipelineConfig = {
      label: 'SSR Blur Pipeline',
      layout: PipelineFactory.createPipelineLayout('ssr_blur_pipeline_layout', [
        this.blurInputLayout,
        this.blurGBufferLayout,
        this.blurOutputLayout,
      ]),
      compute: { module, entryPoint: 'cs' },
    };
    this.blurPipeline = PipelineFactory.createComputePipeline(config);
  }

  private async createComputePipeline(): Promise<void> {
    const device = GPUUtils.getDevice();

    // Layouts
    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();
    this.ssrParamsLayout = BindGroupFactory.getSSRUniformsComputeLayout();
    this.ssrOutputLayout = BindGroupFactory.getSSROutputLayout();

    // Shader
    const shaderCode = await ResourceManager.loadShader('post-processing/ssr.cs');
    const shaderModule = device.createShaderModule({ label: 'ssr_cs', code: shaderCode });

    const config: ComputePipelineConfig = {
      label: 'SSR Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('ssr_compute_pipeline_layout', [
        cameraLayout,
        gbufferLayout,
        this.ssrParamsLayout,
        this.ssrOutputLayout,
      ]),
      compute: { module: shaderModule, entryPoint: 'cs' },
    };

    this.ssrComputePipeline = PipelineFactory.createComputePipeline(config);
  }

  private renderDisabledSSR(): GPUTextureView {
    const commandEncoder = Render.getInstance().getCommandEncoder();
    // Clear the blurred RT — this is the texture ambient_specular.fs reads.
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear SSR (disabled)',
      colorAttachments: [
        {
          view: this.ssrBlurred.getView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    renderPass.end();
    return this.ssrBlurred.getView();
  }

  public generateSSR(
    accLights: GPUTextureView,
    ao: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    gNormalsView: GPUTextureView,
    gDepthView: GPUTextureView,
  ): GPUTextureView {
    if (!QualitySettings.getInstance().getSettings().ssrEnabled) {
      return this.renderDisabledSSR();
    }

    // Rebuild bind group whenever the color source changes (first valid TAA
    // history frame, resize, or TAA toggled on/off).
    if (accLights !== this.lastAccLightsView) {
      this.ssrBindGroup = null;
      this.lastAccLightsView = accLights;
    }
    if (!this.ssrBindGroup) {
      this.createSSRBindGroup(accLights, ao);
    }

    this.executeSSRPass(gBufferBindGroup, gDepthView);
    this.executeBlurPass(gNormalsView, gDepthView);

    return this.ssrBlurred.getView();
  }

  private executeBlurPass(gNormalsView: GPUTextureView, gDepthView: GPUTextureView): void {
    if (
      !this.blurPipeline ||
      !this.blurInputLayout ||
      !this.blurGBufferLayout ||
      !this.blurOutputLayout
    )
      return;

    // Input bind group: raw SSR result
    if (!this.blurInputBindGroup) {
      this.blurInputBindGroup = BindGroupFactory.createBindGroup(
        'ssr_blur_input_bg',
        this.blurInputLayout,
        [
          { binding: 0, resource: this.ssrResult.getView() },
          { binding: 1, resource: SamplerLibrary.simpleSampler! },
        ],
      );
    }

    // GBuffer bind group: rebuilt if views change (e.g. after resize)
    if (
      !this.blurGBufferBindGroup ||
      this.lastBlurNormalsView !== gNormalsView ||
      this.lastBlurDepthView !== gDepthView
    ) {
      this.lastBlurNormalsView = gNormalsView;
      this.lastBlurDepthView = gDepthView;
      this.blurGBufferBindGroup = BindGroupFactory.createBindGroup(
        'ssr_blur_gbuffer_bg',
        this.blurGBufferLayout,
        [
          { binding: 0, resource: gNormalsView },
          { binding: 1, resource: gDepthView },
          { binding: 2, resource: SamplerLibrary.nonFilteringSampler! },
        ],
      );
    }

    // Output bind group: blurred result storage texture
    if (!this.blurOutputBindGroup) {
      this.blurOutputBindGroup = BindGroupFactory.createBindGroup(
        'ssr_blur_output_bg',
        this.blurOutputLayout,
        [{ binding: 0, resource: this.ssrBlurred.getStorageView() }],
      );
    }

    const qs = QualitySettings.getInstance().getSettings();
    const ssrW = Math.floor(Render.width * qs.ssrScale);
    const ssrH = Math.floor(Render.height * qs.ssrScale);
    const encoder = Render.getInstance().getCommandEncoder();
    const ssrBlurTs = GPUProfiler.getInstance().getTimestampWrites('SSR Blur');
    const pass = encoder.beginComputePass({
      label: 'SSR Blur',
      ...(ssrBlurTs ? { timestampWrites: ssrBlurTs } : {}),
    });
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(0, this.blurInputBindGroup);
    pass.setBindGroup(1, this.blurGBufferBindGroup);
    pass.setBindGroup(2, this.blurOutputBindGroup);
    pass.dispatchWorkgroups(Math.ceil(ssrW / 8), Math.ceil(ssrH / 8), 1);
    pass.end();
  }

  public executeSSRPass(gBufferBindGroup: GPUBindGroup, gDepthView: GPUTextureView): void {
    if (!this.isInitialized || !this.ssrComputePipeline) return;

    // ── Hi-Z pyramid build (4 passes, cheap ~0.1 ms) ─────────────────────────
    this.executeHiZBuildPasses(gDepthView);

    const qs = QualitySettings.getInstance().getSettings();
    const ssrW = Math.floor(Render.width * qs.ssrScale);
    const ssrH = Math.floor(Render.height * qs.ssrScale);

    // ── Camera compute bind group (lazily created / refreshed) ───────────────
    const cameraBuffer = Engine.getRender().getMainCamera().getUniformBuffer();
    if (!cameraBuffer) return;
    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'ssr_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }

    // ── Output bind group (lazily created / invalidated on resize) ────────────
    if (!this.ssrOutputBindGroup) {
      this.ssrOutputBindGroup = BindGroupFactory.createBindGroup(
        'ssr_output_bindgroup',
        this.ssrOutputLayout!,
        [{ binding: 0, resource: this.ssrResult.getStorageView() }],
      );
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    const encoder = Render.getInstance().getCommandEncoder();
    const ssrTs = GPUProfiler.getInstance().getTimestampWrites('SSR Compute');
    const pass = encoder.beginComputePass({
      label: 'SSR Compute',
      ...(ssrTs ? { timestampWrites: ssrTs } : {}),
    });

    pass.setPipeline(this.ssrComputePipeline);
    pass.setBindGroup(0, this.cameraComputeBindGroup);
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ssrBindGroup!);
    pass.setBindGroup(3, this.ssrOutputBindGroup);

    pass.dispatchWorkgroups(Math.ceil(ssrW / 8), Math.ceil(ssrH / 8), 1);
    pass.end();
  }

  private executeHiZBuildPasses(gDepthView: GPUTextureView): void {
    if (!this.hizBuildPipelineL0 || !this.hizBuildPipelineL1 || !this.hizTexture) return;

    // Lazily create the level-0 bind group (depends on gLinearDepth view pointer)
    if (!this.hizBuildL0BG || this.lastHiZDepthView !== gDepthView) {
      this.lastHiZDepthView = gDepthView;
      this.hizBuildL0BG = BindGroupFactory.createBindGroup(
        'hiz_build_l0_bg',
        BindGroupFactory.getHiZBuildFromFilterableLayout(),
        [
          { binding: 0, resource: gDepthView },            // src: gLinearDepth (full res)
          { binding: 1, resource: this.hizMipViews[0]! },   // dst: hizTex mip 0 (half res)
        ],
      );
    }

    const encoder = Render.getInstance().getCommandEncoder();
    const baseW = this.hizTexture.width;
    const baseH = this.hizTexture.height;

    // Pass 0: gLinearDepth (render res) → hizTex mip 0 (half res)
    {
      const pass = encoder.beginComputePass({ label: 'Hi-Z Build L0' });
      pass.setPipeline(this.hizBuildPipelineL0);
      pass.setBindGroup(0, this.hizBuildL0BG);
      pass.dispatchWorkgroups(Math.ceil(baseW / 8), Math.ceil(baseH / 8), 1);
      pass.end();
    }

    // Passes 1-3: hizTex mip k → mip k+1
    for (let k = 0; k < ScreenSpaceReflections.HIZ_LEVELS - 1; k++) {
      const mipW = Math.max(1, baseW >> k);
      const mipH = Math.max(1, baseH >> k);
      const dstW = Math.max(1, Math.ceil(mipW / 2));
      const dstH = Math.max(1, Math.ceil(mipH / 2));
      const pass = encoder.beginComputePass({ label: `Hi-Z Build L${k + 1}` });
      pass.setPipeline(this.hizBuildPipelineL1);
      pass.setBindGroup(0, this.hizBuildL1BGs[k]);
      pass.dispatchWorkgroups(Math.ceil(dstW / 8), Math.ceil(dstH / 8), 1);
      pass.end();
    }
  }

  public composeSSR(): void {
    if (!this.isInitialized) return;
  }

  /**
   * Tell SSR whether TAA is currently active.
   * When active, the ray marcher uses half the normal step count because TAA
   * accumulates hits from previous frames — effective quality stays equivalent.
   * Call this every frame (or whenever TAA state changes) from DeferredRenderer.
   * SSR has no direct import of TAAComponent — the flag is purely a numeric hint.
   */
  public setTemporalMode(active: boolean): void {
    this.debugParams.temporalMode = active ? 1.0 : 0.0;
  }

  public getBRDFLUT(): Texture {
    return this.brdfLUT;
  }

  private createSSRBindGroup(accLights: GPUTextureView, _ao: GPUTextureView) {
    this.ssrBindGroup = BindGroupFactory.createBindGroup('ssr_bindgroup', this.ssrParamsLayout!, [
      { binding: 0, resource: accLights },
      { binding: 1, resource: { buffer: this.ssrUniformBuffer } },
      { binding: 2, resource: this.blueNoiseTexture.getTextureView()! },
      // Hi-Z min-depth pyramid — always valid (created in createHiZTexture)
      { binding: 3, resource: this.hizReadView! },
    ]);
  }

  public renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('SSR');
    this._editorFolder.close();

    const p = this.debugParams;
    this._editorFolder.add(p, 'stepSize', 0.01, 2.0).name('Step Size').listen();
    this._editorFolder.add(p, 'maxSteps', 8, 128, 1).name('Max Steps').listen();
    this._editorFolder.add(p, 'maxDistance', 5.0, 300.0).name('Max Distance').listen();
    this._editorFolder.add(p, 'thickness', 0.001, 0.2).name('Thickness').listen();
    this._editorFolder.add(p, 'metallicMin', 0.0, 1.0).name('Metallic Min').listen();
    this._editorFolder.add(p, 'roughnessMax', 0.0, 1.0).name('Roughness Max').listen();
    const enabledProxy = {
      get enabled() {
        return p.enabled > 0.5;
      },
      set enabled(v: boolean) {
        p.enabled = v ? 1.0 : 0.0;
      },
    };
    this._editorFolder.add(enabledProxy, 'enabled').name('Enabled').listen();
  }

  public update(_dt: number): void {
    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();

    GPUUtils.writeBuffer(
      this.ssrUniformBuffer,
      0,
      new Float32Array([
        ambientData.globalFactor,
        this.debugParams.stepSize,
        this.debugParams.maxSteps,
        this.debugParams.maxDistance,
        this.debugParams.thickness,
        this.debugParams.enabled,
        ambientData.reflectionFactor,
        ambientData.diffuseFactor,
        this.debugParams.metallicMin,
        this.debugParams.roughnessMax,
        this.debugParams.temporalMode, // 1.0 when TAA active → halve march steps
        this.frameIndex, // drives blue-noise tile animation in ssr.cs
      ]),
    );
    // Only animate blue-noise when TAA is accumulating; without temporal
    // accumulation each frame would show a different ray offset → flickering.
    if (this.debugParams.temporalMode > 0.0) {
      this.frameIndex = (this.frameIndex + 1) % 8192;
    }
  }

  public dispose(): void {
    this.ssrBindGroup = null;
    this.ssrOutputBindGroup = null;
    this.cameraComputeBindGroup = null;
    this.lastCameraBuffer = null;
    this.lastAccLightsView = null;
    this.blurInputBindGroup = null;
    this.blurGBufferBindGroup = null;
    this.blurOutputBindGroup = null;
    this.lastBlurNormalsView = null;
    this.lastBlurDepthView = null;
    this.hizBuildL0BG = null;
    this.hizBuildL1BGs = [];
    this.hizMipViews = [];
    this.hizReadView = null;
    this.lastHiZDepthView = null;
    if (this.hizTexture) {
      this.hizTexture.destroy();
      this.hizTexture = null;
    }
    this.ssrResult = null as any;
    this.ssrBlurred = null as any;
    this.createRenderTarget();
  }
}
