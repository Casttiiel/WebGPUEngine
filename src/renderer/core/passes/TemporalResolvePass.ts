import { mat4 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { QualitySettings } from '../../../core/engine/QualitySettings';
import { GPUProfiler } from '../../../core/debug/GPUProfiler';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../factories/PipelineFactory';
import { Render } from '../pipeline/Render';
import { GPUUtils } from '../utils/GPUUtils';
import { SamplerLibrary } from '../utils/SamplerLibrary';
import { RenderTarget } from '../../resources/RenderTarget';
import { VelocityBufferManager } from '../managers/VelocityBufferManager';

/** Must match TemporalParams in temporal_common.wgsl: 2 × mat4 + 8 × f32 */
const PARAMS_FLOATS = 2 * 16 + 8;

export interface TemporalResolveSettings {
  /** Minimum current-frame weight (three.js: 0.05 TRAA, 0.025 TAAU). */
  currentFrameWeight: number;
  /** Relative linear-depth jump that counts as a disocclusion. */
  depthThreshold: number;
  /** Relative depth range in the 3×3 that marks a geometric edge (keeps history). */
  edgeDepthDiff: number;
  /** Motion in pixels at which the history is fully distrusted. */
  maxVelocityLength: number;
  /** TAA only: boost the current weight where the history fetch is blurriest. */
  useSubpixelCorrection: boolean;
}

/**
 * Shared machinery of the TAA / TSR compute resolves (taa.cs, tsr.cs):
 * ping-ponged output/history targets (no per-frame history copy), previous-frame linear
 * depth and camera matrices for disocclusion, params upload and dispatch.
 *
 * Output size: render resolution (TAA) or canvas resolution (TSR), via `getOutputSize`.
 */
export class TemporalResolvePass {
  private pipeline!: GPUComputePipeline;
  private inputLayout!: GPUBindGroupLayout;
  private outputLayout!: GPUBindGroupLayout;

  /** Ping-pong pair: frame N writes targets[parity] and reads targets[1 - parity] as history. */
  private targets: [RenderTarget, RenderTarget] = [new RenderTarget(), new RenderTarget()];
  private parity = 0;
  private prevDepthRT!: RenderTarget;

  private paramsBuffer!: GPUBuffer;
  private paramsData = new Float32Array(PARAMS_FLOATS);
  private prevInvProjection = mat4.create();
  private prevInvView = mat4.create();
  private historyValid = false;

  private cameraBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;
  // One bind group set per parity (history / output swap every frame)
  private inputBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private inputKeys: [GPUTextureView[], GPUTextureView[]] = [[], []];
  private outputBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];

  constructor(
    private readonly label: string,
    private readonly shaderPath: string,
    private readonly getOutputSize: () => { width: number; height: number },
  ) {}

  public async load(): Promise<void> {
    const C = GPUShaderStage.COMPUTE;
    this.inputLayout = BindGroupFactory.getLayout(`${this.label}_inputs`, [
      { binding: 0, visibility: C, texture: { sampleType: 'float' } }, // current
      { binding: 1, visibility: C, texture: { sampleType: 'float' } }, // history
      { binding: 2, visibility: C, texture: { sampleType: 'float' } }, // velocity
      { binding: 3, visibility: C, texture: { sampleType: 'float' } }, // linear depth
      { binding: 4, visibility: C, texture: { sampleType: 'float' } }, // prev linear depth
      { binding: 5, visibility: C, sampler: { type: 'filtering' } },
      { binding: 6, visibility: C, buffer: { type: 'uniform' } },
    ]);
    this.outputLayout = BindGroupFactory.getSSROutputLayout(); // rgba16float storage, group 2

    const code = await ResourceManager.loadShader(this.shaderPath);
    const config: ComputePipelineConfig = {
      label: this.label,
      layout: PipelineFactory.createPipelineLayout(`${this.label}_layout`, [
        BindGroupFactory.getCameraComputeLayout(),
        this.inputLayout,
        this.outputLayout,
      ]),
      compute: {
        module: GPUUtils.getDevice().createShaderModule({ label: this.label, code }),
        entryPoint: 'cs',
      },
    };
    this.pipeline = PipelineFactory.createComputePipeline(config);

    this.paramsBuffer = GPUUtils.createBuffer(
      `${this.label}_params`,
      PARAMS_FLOATS * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.prevDepthRT = new RenderTarget();
    this.createTargets();
  }

  /** (Re)creates the targets at the current sizes and restarts the history. */
  public createTargets(): void {
    const { width, height } = this.getOutputSize();
    const fmt: GPUTextureFormat = 'rgba16float';
    this.targets.forEach((rt, i) =>
      rt.createRT(`${this.label}_target_${i}`, width, height, fmt, GPUTextureUsage.STORAGE_BINDING),
    );
    this.prevDepthRT.createRT(
      `${this.label}_prev_linear_depth`,
      Render.width,
      Render.height,
      QualitySettings.getInstance().getSettings().linearDepthTexture,
      GPUTextureUsage.COPY_DST,
    );
    this.inputBindGroups = [null, null];
    this.inputKeys = [[], []];
    this.outputBindGroups = [null, null];
    this.historyValid = false;
  }

  public resetHistory(): void {
    this.historyValid = false;
  }

  public isHistoryValid(): boolean {
    return this.historyValid;
  }

  /** Last resolved frame (the history the next frame will read). */
  public getHistoryView(): GPUTextureView {
    return this.targets[1 - this.parity]!.getView();
  }

  /**
   * Resolves `current` against the history and returns the output view.
   * @param linearDepth G-buffer linear depth (render resolution)
   */
  public execute(
    current: GPUTextureView,
    linearDepth: RenderTarget,
    settings: TemporalResolveSettings,
  ): GPUTextureView {
    const camera = Engine.getRender().getMainCamera();
    const cameraBuffer = camera.getUniformBuffer();
    if (!this.cameraBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraBindGroup = BindGroupFactory.createBindGroup(
        `${this.label}_camera_bg`,
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }

    // Params — previous-frame matrices + settings
    const d = this.paramsData;
    d.set(this.prevInvProjection, 0);
    d.set(this.prevInvView, 16);
    d[32] = settings.currentFrameWeight;
    d[33] = settings.depthThreshold;
    d[34] = settings.edgeDepthDiff;
    d[35] = settings.maxVelocityLength;
    d[36] = settings.useSubpixelCorrection ? 1 : 0;
    d[37] = this.historyValid ? 1 : 0;
    GPUUtils.writeBuffer(this.paramsBuffer, 0, d);

    const p = this.parity;
    const output = this.targets[p]!;
    const history = this.targets[1 - p]!;

    const velocity = VelocityBufferManager.getInstance().getVelocityTextureView();
    const depthView = linearDepth.getView();
    const key = [current, velocity, depthView];
    if (!this.inputBindGroups[p] || key.some((v, i) => v !== this.inputKeys[p]![i])) {
      this.inputKeys[p] = key;
      this.inputBindGroups[p] = BindGroupFactory.createBindGroup(`${this.label}_inputs_bg_${p}`, this.inputLayout, [
        { binding: 0, resource: current },
        { binding: 1, resource: history.getView() },
        { binding: 2, resource: velocity },
        { binding: 3, resource: depthView },
        { binding: 4, resource: this.prevDepthRT.getView() },
        { binding: 5, resource: SamplerLibrary.simpleSampler },
        { binding: 6, resource: { buffer: this.paramsBuffer } },
      ]);
    }
    this.outputBindGroups[p] ??= BindGroupFactory.createBindGroup(
      `${this.label}_output_bg_${p}`,
      this.outputLayout,
      [{ binding: 0, resource: output.getStorageView() }],
    );

    const encoder = Render.getInstance().getCommandEncoder();
    const ts = GPUProfiler.getInstance().getTimestampWrites(this.label);
    const pass = encoder.beginComputePass({ label: this.label, ...(ts ? { timestampWrites: ts } : {}) });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cameraBindGroup!);
    pass.setBindGroup(1, this.inputBindGroups[p]!);
    pass.setBindGroup(2, this.outputBindGroups[p]!);
    pass.dispatchWorkgroups(Math.ceil(output.getWidth() / 8), Math.ceil(output.getHeight() / 8), 1);
    pass.end();

    // History for the next frame: this output becomes the history by swapping parity (no
    // colour copy); this frame's depth and camera are kept for disocclusion.
    encoder.copyTextureToTexture(
      { texture: linearDepth.getTexture() },
      { texture: this.prevDepthRT.getTexture() },
      { width: this.prevDepthRT.getWidth(), height: this.prevDepthRT.getHeight(), depthOrArrayLayers: 1 },
    );
    mat4.copy(this.prevInvProjection, camera.getInvProjectionMatrix());
    mat4.invert(this.prevInvView, camera.getView());
    this.historyValid = true;
    this.parity = 1 - p;

    return output.getView();
  }

  public destroy(): void {
    this.targets.forEach((rt) => rt.destroy());
    this.prevDepthRT?.destroy();
    this.paramsBuffer?.destroy();
  }
}
