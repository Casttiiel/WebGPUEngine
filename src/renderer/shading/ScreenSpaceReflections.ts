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

  // ── SSR ray-march compute ────────────────────────────────────────────────
  private ssrComputePipeline: GPUComputePipeline | null = null;
  private ssrParamsLayout: GPUBindGroupLayout | null = null;
  private ssrOutputLayout: GPUBindGroupLayout | null = null;

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

    this.executeSSRPass(gBufferBindGroup);
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

  public executeSSRPass(gBufferBindGroup: GPUBindGroup): void {
    if (!this.isInitialized || !this.ssrComputePipeline) return;

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

  private createSSRBindGroup(accLights: GPUTextureView, ao: GPUTextureView) {
    this.ssrBindGroup = BindGroupFactory.createBindGroup('ssr_bindgroup', this.ssrParamsLayout!, [
      {
        binding: 0,
        resource: accLights,
      },
      {
        binding: 1,
        resource: { buffer: this.ssrUniformBuffer },
      },
    ]);
  }

  public renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (!gui.beginWindow('SSR')) return;

    gui.addSlider('Step Size', this.debugParams.stepSize, 0.01, 2.0, (v) => {
      this.debugParams.stepSize = v;
    });
    gui.addSliderInt('Max Steps', this.debugParams.maxSteps, 8, 128, (v) => {
      this.debugParams.maxSteps = v;
    });
    gui.addSlider('Max Distance', this.debugParams.maxDistance, 5.0, 300.0, (v) => {
      this.debugParams.maxDistance = v;
    });
    gui.addSlider('Thickness', this.debugParams.thickness, 0.001, 0.2, (v) => {
      this.debugParams.thickness = v;
    });
    gui.addSlider('Metallic Min', this.debugParams.metallicMin, 0.0, 1.0, (v) => {
      this.debugParams.metallicMin = v;
    });
    gui.addSlider('Roughness Max', this.debugParams.roughnessMax, 0.0, 1.0, (v) => {
      this.debugParams.roughnessMax = v;
    });
    gui.addCheckbox('Enabled', this.debugParams.enabled > 0.5, (v) => {
      this.debugParams.enabled = v ? 1.0 : 0.0;
    });

    gui.endWindow();
  }

  public update(dt: number): void {
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
        0.0, // _pad1
      ]),
    );
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
    this.ssrResult = null as any;
    this.ssrBlurred = null as any;
    this.createRenderTarget();
  }
}
