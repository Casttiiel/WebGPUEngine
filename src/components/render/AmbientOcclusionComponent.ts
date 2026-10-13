import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';
import { Render } from '../../renderer/core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { CameraComponent } from './CameraComponent';
import { GPUProfiler } from '../../core/debug/GPUProfiler';

// ─── Layout constant (must match WGSL AOParams struct in ao_common.wgsl: 12 × f32) ──────
const AO_PARAMS_SIZE = 48;

// From the Activision GTAO paper (same tables as three.js GTAONode)
const TEMPORAL_ROTATIONS = [60, 300, 180, 240, 120, 0];
const SPATIAL_OFFSETS = [0, 0.5, 0.25, 0.75];

export type AOMode = 'gtao' | 'ssao';

/** Optional prefab data (`"ambient_occlusion": { ... }`). Omitted fields keep their defaults. */
export interface AmbientOcclusionComponentData {
  mode?: AOMode;
  samples?: number;
  radius?: number;
  resolutionScale?: number;
  scale?: number;
  thickness?: number;
  temporalFiltering?: boolean;
  intensity?: number;
  bias?: number;
  blurEnabled?: boolean;
  blurSharpness?: number;
}

/**
 * Screen-space ambient occlusion, ported from three.js (webgpu_postprocessing_ao):
 *  - GTAO: ground-truth horizon-based AO. Not spatially denoised — the per-frame slice
 *          rotation is resolved by a temporal AA pass (add `taa`/`tsr` to the camera).
 *  - SSAO: normalized obscurance + separable depth-aware blur (self-denoised).
 * Output packing (consumed by the lighting shaders): AO scalar in .b.
 */
export class AmbientOcclusionComponent extends Component {
  private device: GPUDevice;
  private loaded = false;

  // Render targets — all need STORAGE_BINDING (compute write) + TEXTURE_BINDING (read input)
  private rawAOTarget!: RenderTarget;
  private intermediateAOTarget!: RenderTarget; // horizontal blur output
  private finalAOResult!: RenderTarget;
  private aoWidth = 0;
  private aoHeight = 0;

  private paramsBuffer!: GPUBuffer;
  private paramsData = new Float32Array(AO_PARAMS_SIZE / 4);
  private frameId = 0;

  // ── User-tunable settings (defaults from the three.js example) ────────────────
  private isEnabled: boolean;
  private mode: AOMode = 'gtao';
  private samples: number;
  private radius = 0.4;
  /** AO resolution relative to the render resolution. */
  private resolutionScale: number;
  // GTAO
  private scale = 0.8;
  private thickness = 1;
  private temporalFiltering = true;
  // SSAO
  private intensity = 2;
  private bias = 0.025;
  private blurEnabled = true;
  private blurSharpness = 2;

  // ── Compute pipelines ────────────────────────────────────────────────────────
  private gtaoPipeline!: GPUComputePipeline;
  private ssaoPipeline!: GPUComputePipeline;
  private blurHPipeline!: GPUComputePipeline;
  private blurVPipeline!: GPUComputePipeline;
  private blurVPSXPipeline!: GPUComputePipeline;

  // ── Bind group layouts (custom to this component) ────────────────────────────
  /** Group 2 of the AO passes: AOParams UBO */
  private paramsLayout!: GPUBindGroupLayout;
  /** Group 2 of the blur passes: AOParams UBO + AO input texture */
  private blurInputLayout!: GPUBindGroupLayout;
  /** Group 3 of all passes: write-only rgba16float storage texture */
  private storageWriteLayout!: GPUBindGroupLayout;

  // ── Bind groups ──────────────────────────────────────────────────────────────
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;

  /** Group 2 of the AO passes — stable after load */
  private paramsBindGroup: GPUBindGroup | null = null;
  // Rebuilt lazily on resize (reference the AO render targets)
  private rawOutputBindGroup: GPUBindGroup | null = null;
  private finalOutputBindGroup: GPUBindGroup | null = null;
  private blurHInputBindGroup: GPUBindGroup | null = null;
  private blurHOutputBindGroup: GPUBindGroup | null = null;
  private blurVInputBindGroup: GPUBindGroup | null = null;
  private blurVOutputBindGroup: GPUBindGroup | null = null;

  constructor() {
    super();
    this.device = GPUUtils.getDevice();
    const qs = QualitySettings.getInstance().getSettings();
    this.isEnabled = qs.enableAO;
    this.samples = qs.aoSampleCount;
    this.resolutionScale = qs.aoScale;
  }

  // ─── Component lifecycle ──────────────────────────────────────────────────────

  public async load(data: AmbientOcclusionComponentData = {}): Promise<void> {
    if (data.mode !== undefined) {
      this.mode = data.mode;
      // As in the three.js example: SSAO looks best at full resolution
      if (data.mode === 'ssao') this.resolutionScale = 1;
    }
    if (data.samples !== undefined) this.samples = data.samples;
    if (data.radius !== undefined) this.radius = data.radius;
    if (data.resolutionScale !== undefined) this.resolutionScale = data.resolutionScale;
    if (data.scale !== undefined) this.scale = data.scale;
    if (data.thickness !== undefined) this.thickness = data.thickness;
    if (data.temporalFiltering !== undefined) this.temporalFiltering = data.temporalFiltering;
    if (data.intensity !== undefined) this.intensity = data.intensity;
    if (data.bias !== undefined) this.bias = data.bias;
    if (data.blurEnabled !== undefined) this.blurEnabled = data.blurEnabled;
    if (data.blurSharpness !== undefined) this.blurSharpness = data.blurSharpness;

    this.rawAOTarget = new RenderTarget();
    this.intermediateAOTarget = new RenderTarget();
    this.finalAOResult = new RenderTarget();
    this.createTargets();

    this.paramsBuffer = GPUUtils.createBuffer(
      'AO Parameters Buffer',
      AO_PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.createLayouts();
    await this.createPipelines();
    this.paramsBindGroup = BindGroupFactory.createBindGroup(
      'ao_params_bindgroup',
      this.paramsLayout,
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'ambient_occlusion', (comp) => {
      const c = comp as AmbientOcclusionComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    this.rawAOTarget.destroy();
    this.intermediateAOTarget.destroy();
    this.finalAOResult.destroy();
    this.createTargets();

    // Texture-view bind groups reference stale GPU textures — must regenerate lazily
    this.rawOutputBindGroup = null;
    this.finalOutputBindGroup = null;
    this.blurHInputBindGroup = null;
    this.blurHOutputBindGroup = null;
    this.blurVInputBindGroup = null;
    this.blurVOutputBindGroup = null;
  }

  // ─── Setup helpers ────────────────────────────────────────────────────────────

  private createTargets(): void {
    // r16float is not a valid WebGPU storage texture format; rgba16float is.
    const format: GPUTextureFormat = 'rgba16float';
    this.aoWidth = Math.max(1, Math.round(Render.width * this.resolutionScale));
    this.aoHeight = Math.max(1, Math.round(Render.height * this.resolutionScale));

    // RENDER_ATTACHMENT (added by createRT): "disabled AO" clear pass
    // TEXTURE_BINDING: blur / lighting read the AO targets
    // STORAGE_BINDING: compute shaders write to all targets
    const extraUsage = GPUTextureUsage.STORAGE_BINDING;
    this.rawAOTarget.createRT('raw_ao_result.dds', this.aoWidth, this.aoHeight, format, extraUsage);
    this.intermediateAOTarget.createRT(
      'intermediate_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      format,
      extraUsage,
    );
    this.finalAOResult.createRT(
      'final_ao_result.dds',
      this.aoWidth,
      this.aoHeight,
      format,
      extraUsage,
    );
  }

  private createLayouts(): void {
    this.paramsLayout = BindGroupFactory.getLayout('ao_params_compute', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]);

    this.blurInputLayout = BindGroupFactory.getLayout('ao_blur_input_compute', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
    ]);

    this.storageWriteLayout = BindGroupFactory.getLayout('ao_storage_write_rgba16f', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
    ]);
  }

  private async createPipelines(): Promise<void> {
    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();

    const aoLayout = PipelineFactory.createPipelineLayout('ao_pipeline_layout', [
      cameraLayout,
      gbufferLayout,
      this.paramsLayout,
      this.storageWriteLayout,
    ]);
    const blurLayout = PipelineFactory.createPipelineLayout('ao_blur_pipeline_layout', [
      cameraLayout,
      gbufferLayout,
      this.blurInputLayout,
      this.storageWriteLayout,
    ]);

    const [gtaoCode, ssaoCode, blurCode] = await Promise.all([
      ResourceManager.loadShader('post-processing/gtao.cs'),
      ResourceManager.loadShader('post-processing/ssao.cs'),
      ResourceManager.loadShader('post-processing/ao_blur.cs'),
    ]);
    const gtaoModule = this.device.createShaderModule({ label: 'gtao_cs', code: gtaoCode });
    const ssaoModule = this.device.createShaderModule({ label: 'ssao_cs', code: ssaoCode });
    const blurModule = this.device.createShaderModule({ label: 'ao_blur_cs', code: blurCode });

    const create = (label: string, module: GPUShaderModule, layout: GPUPipelineLayout, entryPoint: string) => {
      const config: ComputePipelineConfig = { label, layout, compute: { module, entryPoint } };
      return PipelineFactory.createComputePipeline(config);
    };

    this.gtaoPipeline = create('GTAO Compute Pipeline', gtaoModule, aoLayout, 'cs');
    this.ssaoPipeline = create('SSAO Compute Pipeline', ssaoModule, aoLayout, 'cs');
    this.blurHPipeline = create('AO Blur Horizontal', blurModule, blurLayout, 'cs_h');
    this.blurVPipeline = create('AO Blur Vertical', blurModule, blurLayout, 'cs_v');
    this.blurVPSXPipeline = create('AO Blur Vertical PSX', blurModule, blurLayout, 'cs_v_psx');
  }

  // ─── Per-frame bind group helpers (lazy / cached) ─────────────────────────────

  private getCameraComputeBindGroup(): GPUBindGroup | null {
    const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | undefined;
    const cameraBuffer = cameraComp?.getCamera().getUniformBuffer();
    if (!cameraBuffer) return null;

    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'ao_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }
    return this.cameraComputeBindGroup;
  }

  private storageBindGroup(label: string, target: RenderTarget): GPUBindGroup {
    return BindGroupFactory.createBindGroup(label, this.storageWriteLayout, [
      { binding: 0, resource: target.getStorageView() },
    ]);
  }

  private blurInputBindGroup(label: string, input: RenderTarget): GPUBindGroup {
    return BindGroupFactory.createBindGroup(label, this.blurInputLayout, [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: input.getView() },
    ]);
  }

  // ─── Main compute entry point ─────────────────────────────────────────────────

  /**
   * GTAO: one pass. SSAO: AO pass + separable depth-aware blur (H → V).
   * PSX dithering always runs the blur so the stipple is applied to a smooth signal.
   * Always returns the finalAOResult view: AmbientLight/SSR cache their bind groups
   * on it and only rebuild them on a global resize.
   * @param gBufferComputeBindGroup G-Buffer bind group with COMPUTE visibility.
   */
  public compute(gBufferComputeBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.isEnabled) {
      return this.renderDisabledAO();
    }

    const cameraBindGroup = this.getCameraComputeBindGroup();
    if (!cameraBindGroup) {
      return this.renderDisabledAO();
    }

    this.updateUniforms();

    const isGTAO = this.mode === 'gtao';
    const isPSX = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';
    const runBlur = isPSX || (!isGTAO && this.blurEnabled);

    const encoder = Render.getInstance().getCommandEncoder();
    const wX = Math.ceil(this.aoWidth / 8);
    const wY = Math.ceil(this.aoHeight / 8);
    const profiler = GPUProfiler.getInstance();

    // ── Pass 1: AO (→ raw when blurred afterwards, else straight to final) ──
    const aoLabel = isGTAO ? 'GTAO Compute' : 'SSAO Compute';
    const aoTs = profiler.getTimestampWrites(aoLabel);
    const aoPass = encoder.beginComputePass({
      label: aoLabel,
      ...(aoTs ? { timestampWrites: aoTs } : {}),
    });
    aoPass.setPipeline(isGTAO ? this.gtaoPipeline : this.ssaoPipeline);
    aoPass.setBindGroup(0, cameraBindGroup);
    aoPass.setBindGroup(1, gBufferComputeBindGroup);
    aoPass.setBindGroup(2, this.paramsBindGroup!);
    this.rawOutputBindGroup ??= this.storageBindGroup('ao_raw_output', this.rawAOTarget);
    this.finalOutputBindGroup ??= this.storageBindGroup('ao_final_output', this.finalAOResult);
    aoPass.setBindGroup(3, runBlur ? this.rawOutputBindGroup : this.finalOutputBindGroup);
    aoPass.dispatchWorkgroups(wX, wY, 1);
    aoPass.end();

    if (!runBlur) {
      return this.finalAOResult.getView();
    }

    // ── Pass 2: depth-aware blur — horizontal (raw → intermediate) ───────────
    this.blurHInputBindGroup ??= this.blurInputBindGroup('ao_blur_h_input', this.rawAOTarget);
    this.blurHOutputBindGroup ??= this.storageBindGroup(
      'ao_blur_h_output',
      this.intermediateAOTarget,
    );
    const blurHTs = profiler.getTimestampWrites('AO Blur Horizontal');
    const blurHPass = encoder.beginComputePass({
      label: 'AO Blur Horizontal',
      ...(blurHTs ? { timestampWrites: blurHTs } : {}),
    });
    blurHPass.setPipeline(this.blurHPipeline);
    blurHPass.setBindGroup(0, cameraBindGroup);
    blurHPass.setBindGroup(1, gBufferComputeBindGroup);
    blurHPass.setBindGroup(2, this.blurHInputBindGroup);
    blurHPass.setBindGroup(3, this.blurHOutputBindGroup);
    blurHPass.dispatchWorkgroups(wX, wY, 1);
    blurHPass.end();

    // ── Pass 3: depth-aware blur — vertical (intermediate → final) ───────────
    this.blurVInputBindGroup ??= this.blurInputBindGroup(
      'ao_blur_v_input',
      this.intermediateAOTarget,
    );
    this.blurVOutputBindGroup ??= this.storageBindGroup('ao_blur_v_output', this.finalAOResult);
    const blurVTs = profiler.getTimestampWrites('AO Blur Vertical');
    const blurVPass = encoder.beginComputePass({
      label: 'AO Blur Vertical',
      ...(blurVTs ? { timestampWrites: blurVTs } : {}),
    });
    blurVPass.setPipeline(isPSX ? this.blurVPSXPipeline : this.blurVPipeline);
    blurVPass.setBindGroup(0, cameraBindGroup);
    blurVPass.setBindGroup(1, gBufferComputeBindGroup);
    blurVPass.setBindGroup(2, this.blurVInputBindGroup);
    blurVPass.setBindGroup(3, this.blurVOutputBindGroup);
    blurVPass.dispatchWorkgroups(wX, wY, 1);
    blurVPass.end();

    return this.finalAOResult.getView();
  }

  // ── Disabled path: render pass that clears to white (no occlusion) ───────────
  private renderDisabledAO(): GPUTextureView {
    const commandEncoder = Render.getInstance().getCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear AO Target',
      colorAttachments: [
        {
          view: this.finalAOResult.getView(),
          clearValue: { r: 0.5, g: 0.5, b: 1.0, a: 1.0 }, // AO = 1 in .b
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    renderPass.end();
    return this.finalAOResult.getView();
  }

  // ── Uniform update ────────────────────────────────────────────────────────────

  private updateUniforms(): void {
    // Temporal slice rotation / jitter offset (three.js GTAONode.updateBefore)
    let temporalDirection = 0;
    let temporalOffset = 1;
    if (this.mode === 'gtao' && this.temporalFiltering) {
      temporalDirection = TEMPORAL_ROTATIONS[this.frameId % 6]! / 360;
      temporalOffset = SPATIAL_OFFSETS[this.frameId % 4]!;
    }
    this.frameId++;

    const d = this.paramsData;
    d[0] = Math.round(this.samples);
    d[1] = this.radius;
    d[2] = this.thickness;
    d[3] = this.scale;
    d[4] = this.intensity;
    d[5] = this.bias;
    d[6] = this.blurSharpness;
    d[7] = temporalDirection;
    d[8] = temporalOffset;
    d[9] = this.resolutionScale;

    this.device.queue.writeBuffer(this.paramsBuffer, 0, d.buffer);
  }

  // ── Debug UI ──────────────────────────────────────────────────────────────────

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Ambient Occlusion');
    this._editorFolder.close();
    this._editorFolder.add(this, 'isEnabled').name('Enable AO').listen();
    this._editorFolder
      .add(this, 'mode', ['gtao', 'ssao'])
      .name('AO type')
      .onChange(() => {
        // As in the three.js example: half resolution suffices for GTAO (TAA smooths it),
        // SSAO looks best at full resolution.
        this.resolutionScale = this.mode === 'ssao' ? 1 : 0.5;
        Render.applyRenderResolution();
      })
      .listen();
    this._editorFolder
      .add(this, 'resolutionScale', 0.25, 1)
      .name('Resolution')
      .onFinishChange(() => Render.applyRenderResolution())
      .listen();
    this._editorFolder.add(this, 'samples', 4, 32, 1).name('Samples').listen();
    this._editorFolder.add(this, 'radius', 0.1, 1).name('Radius').listen();
    this._editorFolder.add(this, 'scale', 0.01, 1).name('GTAO Scale').listen();
    this._editorFolder.add(this, 'thickness', 0.01, 2).name('GTAO Thickness').listen();
    this._editorFolder.add(this, 'temporalFiltering').name('GTAO Temporal Filtering').listen();
    this._editorFolder.add(this, 'intensity', 0, 4).name('SSAO Intensity').listen();
    this._editorFolder.add(this, 'bias', 0, 0.2).name('SSAO Bias').listen();
    this._editorFolder.add(this, 'blurEnabled').name('SSAO Blur').listen();
    this._editorFolder.add(this, 'blurSharpness', 0, 8).name('SSAO Blur Sharpness').listen();
  }

  public update(_dt: number): void {}

  public renderDebug(): void {}

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
