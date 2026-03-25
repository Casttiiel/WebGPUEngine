import { ResourceManager } from '../../core/engine/ResourceManager';
import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Engine } from '../../core/engine/Engine';

// ── Params layout (must match AdaptParams struct in adapt shader) ─────────────
// [0] dt, [1] adaptSpeedUp, [2] adaptSpeedDown, [3] keyValue,
// [4] minExposure, [5] maxExposure, [6] compensation, [7] lowPercentile,
// [8] highPercentile, [9-11] _pad
const PARAMS_FLOATS = 12;
const PARAMS_BYTE_SIZE = PARAMS_FLOATS * 4; // 48 bytes

// Luminance pass dispatches 16×16 workgroups of 8×8 threads → 16 384 samples
const LUMINANCE_DISPATCH_X = 16;
const LUMINANCE_DISPATCH_Y = 16;

export class AutoExposureComponent extends Component {
  private device!: GPUDevice;
  private isLoaded = false;

  // User-tunable settings (exposed to editor / debug UI)
  private adaptSpeedUp = 0.5; // Speed adapting toward bright  (iris closing — τ ≈ 0.4s)
  private adaptSpeedDown = 0.5; // Speed adapting toward dark    (iris opening — τ ≈ 2.0s)
  private keyValue = 0.18; // 18 % grey target
  private minExposure = 0.1;
  private maxExposure = 3.0;
  private compensation = 0.0; // EV stops added on top
  private lowPercentile = 0.1; // Discard this fraction of darkest pixels
  private highPercentile = 0.9; // Discard pixels above this brightness fraction

  // ── Compute pipelines ──────────────────────────────────────────────────────
  private luminanceShader!: GPUShaderModule;
  private adaptShader!: GPUShaderModule;
  private luminancePipeline!: GPUComputePipeline;
  private adaptPipeline!: GPUComputePipeline;

  // ── Bind group layouts ─────────────────────────────────────────────────────
  private luminanceSrcLayout!: GPUBindGroupLayout; // group 0 of luminance pass
  private accumulatorLayout!: GPUBindGroupLayout; // group 1 of luminance / group 0 of adapt
  private exposureWriteLayout!: GPUBindGroupLayout; // group 1 of adapt
  private adaptParamsLayout!: GPUBindGroupLayout; // group 2 of adapt

  // ── GPU Buffers ────────────────────────────────────────────────────────────
  /** 256-bin i32 histogram — filled by luminance pass, reset by adapt pass. */
  private histogramBuffer!: GPUBuffer;
  /** f32 adapted exposure — read by ToneMappingComponent via a bind group. */
  private exposureBuffer!: GPUBuffer;
  /** Uniform params (dt, speeds, key, limits…). */
  private paramsBuffer!: GPUBuffer;
  private paramsData!: Float32Array;

  // ── Bind groups (fixed — buffers don't change) ────────────────────────────
  private histogramBindGroup!: GPUBindGroup; // luminance group 1 / adapt group 0
  private exposureWriteBindGroup!: GPUBindGroup;
  private adaptParamsBindGroup!: GPUBindGroup;

  // ── Per-texture luminance bind group (group 0) ────────────────────────────
  private luminanceSrcBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ── Component lifecycle ────────────────────────────────────────────────────

  public async load(): Promise<void> {
    this.device = Render.getInstance().getDevice();

    await this.loadShaders();
    this.createLayouts();
    this.createBuffers();
    this.createPipelines();
    this.createFixedBindGroups();

    this.isLoaded = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run both compute passes (luminance measure + temporal adaptation).
   * Call once per frame, before tone mapping.
   * @param hdrTexture  The HDR scene colour texture view.
   * @param dt          Delta time in seconds from the current frame.
   */
  public apply(hdrTexture: GPUTextureView, dt: number): void {
    if (!this.isLoaded || !this.enabled) return;

    this.updateParamsBuffer(dt);
    this.runPasses(hdrTexture);
  }

  /**
   * Returns the GPU buffer containing the current adapted exposure value (f32).
   * Pass this to ToneMappingComponent.setExposureBuffer() once after loading.
   */
  public getExposureBuffer(): GPUBuffer {
    return this.exposureBuffer;
  }

  public hasLoaded(): boolean {
    return this.isLoaded;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async loadShaders(): Promise<void> {
    const [lumRes, adaptRes] = await Promise.all([
      ResourceManager.fetch('assets/shaders/post-processing/auto_exposure_luminance.compute.wgsl'),
      ResourceManager.fetch('assets/shaders/post-processing/auto_exposure_adapt.compute.wgsl'),
    ]);

    this.luminanceShader = this.device.createShaderModule({
      label: 'Auto Exposure Luminance Compute Shader',
      code: await lumRes.text(),
    });

    this.adaptShader = this.device.createShaderModule({
      label: 'Auto Exposure Adapt Compute Shader',
      code: await adaptRes.text(),
    });
  }

  private createLayouts(): void {
    // Luminance pass — group 0: HDR texture + sampler
    this.luminanceSrcLayout = BindGroupFactory.getLayout('ae_luminance_src', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
      },
    ]);

    // Shared — histogram: 256 atomic i32 bins (luminance group 1 / adapt group 0)
    this.accumulatorLayout = BindGroupFactory.getLayout('ae_histogram', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ]);

    // Adapt pass — group 1: exposure f32 storage buffer (read_write)
    this.exposureWriteLayout = BindGroupFactory.getLayout('ae_exposure_write', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ]);

    // Adapt pass — group 2: params uniform buffer
    this.adaptParamsLayout = BindGroupFactory.getLayout('ae_adapt_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  private createBuffers(): void {
    // histogram: 256 bins × 4 bytes, zeroed at startup (adapt shader resets per-frame)
    this.histogramBuffer = GPUUtils.createBuffer(
      'ae_histogram_buffer',
      256 * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.device.queue.writeBuffer(this.histogramBuffer, 0, new Int32Array(256));

    // exposure: 4 bytes, initialised to 1.0 so the first frame is unaffected
    this.exposureBuffer = GPUUtils.createBuffer(
      'ae_exposure_buffer',
      4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.device.queue.writeBuffer(this.exposureBuffer, 0, new Float32Array([1.0]));

    // params: 8 floats = 32 bytes
    this.paramsBuffer = GPUUtils.createBuffer(
      'ae_params_buffer',
      PARAMS_BYTE_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.paramsData = new Float32Array(PARAMS_FLOATS);
    // Write default values so the buffer isn't sent to the GPU uninitialised
    this.writeParamsData(1.0 / 60.0);
  }

  private createPipelines(): void {
    // ── Luminance pipeline ──────────────────────────────────────────────────
    const luminanceConfig: ComputePipelineConfig = {
      label: 'Auto Exposure Luminance Pipeline',
      layout: PipelineFactory.createPipelineLayout('ae_luminance_layout', [
        this.luminanceSrcLayout,
        this.accumulatorLayout,
      ]),
      compute: {
        module: this.luminanceShader,
        entryPoint: 'cs_luminance',
      },
    };
    this.luminancePipeline = PipelineFactory.createComputePipeline(luminanceConfig);

    // ── Adapt pipeline ──────────────────────────────────────────────────────
    const adaptConfig: ComputePipelineConfig = {
      label: 'Auto Exposure Adapt Pipeline',
      layout: PipelineFactory.createPipelineLayout('ae_adapt_layout', [
        this.accumulatorLayout,
        this.exposureWriteLayout,
        this.adaptParamsLayout,
      ]),
      compute: {
        module: this.adaptShader,
        entryPoint: 'cs_adapt',
      },
    };
    this.adaptPipeline = PipelineFactory.createComputePipeline(adaptConfig);
  }

  private createFixedBindGroups(): void {
    this.histogramBindGroup = BindGroupFactory.createBindGroup(
      'ae_histogram_bindgroup',
      this.accumulatorLayout,
      [{ binding: 0, resource: { buffer: this.histogramBuffer } }],
    );

    this.exposureWriteBindGroup = BindGroupFactory.createBindGroup(
      'ae_exposure_write_bindgroup',
      this.exposureWriteLayout,
      [{ binding: 0, resource: { buffer: this.exposureBuffer } }],
    );

    this.adaptParamsBindGroup = BindGroupFactory.createBindGroup(
      'ae_adapt_params_bindgroup',
      this.adaptParamsLayout,
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );
  }

  private writeParamsData(dt: number): void {
    this.paramsData[0] = dt;
    this.paramsData[1] = this.adaptSpeedUp;
    this.paramsData[2] = this.adaptSpeedDown;
    this.paramsData[3] = this.keyValue;
    this.paramsData[4] = this.minExposure;
    this.paramsData[5] = this.maxExposure;
    this.paramsData[6] = this.compensation;
    this.paramsData[7] = this.lowPercentile;
    this.paramsData[8] = this.highPercentile;
    // [9-11] padding
  }

  private updateParamsBuffer(dt: number): void {
    this.writeParamsData(dt);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  /** Build (and cache) a bind group for group 0 of the luminance pass. */
  private getLuminanceSrcBindGroup(hdrTexture: GPUTextureView): GPUBindGroup {
    let bg = this.luminanceSrcBindGroupCache.get(hdrTexture);
    if (!bg) {
      const sampler = SamplerLibrary.simpleSampler;
      bg = BindGroupFactory.createBindGroup('ae_luminance_src_bindgroup', this.luminanceSrcLayout, [
        { binding: 0, resource: hdrTexture },
        { binding: 1, resource: sampler },
      ]);
      this.luminanceSrcBindGroupCache.set(hdrTexture, bg);
    }
    return bg;
  }

  /**
   * Runs both compute passes in a single command encoder.
   * WebGPU spec §25.4 guarantees that storage buffer writes from a compute pass
   * are visible to all subsequent passes within the same command buffer, so no
   * separate submit or explicit barrier is needed between luminance and adapt.
   */
  private runPasses(hdrTexture: GPUTextureView): void {
    const encoder = this.device.createCommandEncoder({ label: 'AutoExposure' });

    // Pass 1 — sample HDR, accumulate log-luminance into accumulatorBuffer
    const lum = encoder.beginComputePass({ label: 'AE Luminance' });
    lum.setPipeline(this.luminancePipeline);
    lum.setBindGroup(0, this.getLuminanceSrcBindGroup(hdrTexture));
    lum.setBindGroup(1, this.histogramBindGroup);
    lum.dispatchWorkgroups(LUMINANCE_DISPATCH_X, LUMINANCE_DISPATCH_Y, 1);
    lum.end();

    // Pass 2 — read + reset accumulator, write adapted exposure to exposureBuffer
    const adapt = encoder.beginComputePass({ label: 'AE Adapt' });
    adapt.setPipeline(this.adaptPipeline);
    adapt.setBindGroup(0, this.histogramBindGroup);
    adapt.setBindGroup(1, this.exposureWriteBindGroup);
    adapt.setBindGroup(2, this.adaptParamsBindGroup);
    adapt.dispatchWorkgroups(1, 1, 1);
    adapt.end();

    this.device.queue.submit([encoder.finish()]);
  }

  // ── Unused Component interface stubs ──────────────────────────────────────

  public update(_dt: number): void {}

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // beginWindow returns true only on first call — controls are added once,
    // .listen() keeps them reactive every frame.
    if (!gui.beginWindow('Auto Exposure', true)) return;

    const folder = (gui as any).folders?.get('Auto Exposure');
    if (!folder) {
      gui.endWindow();
      return;
    }

    folder.add(this, 'enabled').name('Enable').listen();
    folder.add(this, 'keyValue', 0.01, 1.0, 0.01).name('Key Value').listen();
    folder.add(this, 'adaptSpeedUp', 0.0, 5.0, 0.05).name('Adapt Speed Up').listen();
    folder.add(this, 'adaptSpeedDown', 0.0, 5.0, 0.05).name('Adapt Speed Down').listen();
    folder.add(this, 'minExposure', 0.01, 5.0, 0.01).name('Min Exposure').listen();
    folder.add(this, 'maxExposure', 1.0, 20.0, 0.1).name('Max Exposure').listen();
    folder.add(this, 'compensation', -4.0, 4.0, 0.1).name('EV Compensation').listen();
    folder.add(this, 'lowPercentile', 0.0, 0.5, 0.01).name('Low Percentile').listen();
    folder.add(this, 'highPercentile', 0.5, 1.0, 0.01).name('High Percentile').listen();

    gui.endWindow();
  }

  public debugInMenu(): void {}

  public renderDebug(): void {}

  // ── Cleanup ────────────────────────────────────────────────────────────────

  public dispose(): void {
    this.histogramBuffer?.destroy();
    this.exposureBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.luminanceSrcBindGroupCache.clear();
  }
}
