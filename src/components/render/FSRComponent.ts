import { ResourceManager } from '../../core/engine/ResourceManager';
import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Engine } from '../../core/engine/Engine';
import { FSRComponentData } from '../../types/FSRComponentData.type';
import { GPUProfiler } from '../../core/debug/GPUProfiler';

/**
 * FSR 1.0 — FidelityFX Super Resolution
 *
 * Upscales the internal render resolution (Render.width × Render.height) to the
 * physical canvas resolution (Render.canvasSize) in two compute passes:
 *
 *   EASU  — Edge-Adaptive Spatial Upsampling using a 12-tap Catmull-Rom bicubic
 *            reconstruction with anti-ringing clamping.
 *   RCAS  — Robust Contrast-Adaptive Sharpening applied at canvas resolution.
 *
 * Pipeline order: … → tone_mapping → FSR (this) → fxaa → smaa → …
 *
 * The component is a no-op when renderResolution = 1.0 AND enableRCAS = false.
 * When renderResolution < 1.0 EASU always runs; RCAS is optional.
 */
export class FSRComponent extends Component {
  private device!: GPUDevice;
  private isLoaded = false;

  // ── Public settings (exposed in debug UI) ─────────────────────────────────
  public override enabled = true;
  /** Run RCAS sharpening pass after EASU.  Can be disabled to save GPU time. */
  public enableRCAS = true;
  /**
   * RCAS sharpness:  0 = maximum sharpening,  2 = very gentle.
   * Internally mapped to exp2(-sharpness) for the GPU uniform.
   */
  public rcasSharpness = 0.2;

  // ── Compute shaders ────────────────────────────────────────────────────────
  private easuShader!: GPUShaderModule;
  private rcasShader!: GPUShaderModule;

  // ── Compute pipelines ──────────────────────────────────────────────────────
  private easuPipeline!: GPUComputePipeline;
  private rcasPipeline!: GPUComputePipeline;

  // ── Shared bind group layouts (3 groups, same slots in both shaders) ───────
  /** Group 0: input texture_2d */
  private inputTexLayout!: GPUBindGroupLayout;
  /** Group 1: output texture_storage_2d (write-only, rgba16float) */
  private storageTexLayout!: GPUBindGroupLayout;
  /** Group 2: params uniform buffer */
  private paramsLayout!: GPUBindGroupLayout;

  // ── Render targets at CANVAS resolution ───────────────────────────────────
  private easuResult!: RenderTarget; // EASU writes here
  private rcasResult!: RenderTarget; // RCAS writes here (final output)

  // ── Params GPU buffers ─────────────────────────────────────────────────────
  /** [inputW, inputH, outputW, outputH] — updated every apply() call */
  private easuParamsBuffer!: GPUBuffer;
  /** [sharpness, 0, 0, 0] — updated whenever rcasSharpness changes */
  private rcasParamsBuffer!: GPUBuffer;

  // ── Fixed bind groups (rebuilt on resize) ─────────────────────────────────
  private easuOutputBindGroup!: GPUBindGroup;
  private rcasOutputBindGroup!: GPUBindGroup;
  /** Points at easuResult for RCAS input — also rebuilt on resize */
  private rcasInputBindGroup!: GPUBindGroup;

  // ── Fixed params bind groups (created once after load) ────────────────────
  private easuParamsBindGroup!: GPUBindGroup;
  private rcasParamsBindGroup!: GPUBindGroup;

  // ── Per-frame EASU input bind group cache ─────────────────────────────────
  // The input view from the previous pass can change, so we cache lazily.
  private easuInputCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ── Reusable typed arrays for GPU buffer uploads (avoid per-frame allocation) ──
  private readonly easuParamsData = new Float32Array(8);
  private readonly rcasParamsData = new Float32Array(4);
  private lastRcasSharpness = NaN;
  private easuParamsDirty = true;

  // ── Cached dispatch sizes (only change on resize) ─────────────────────────
  private dispatchX = 0;
  private dispatchY = 0;

  // ── Scale mode ────────────────────────────────────────────────────────────
  /** 'ratio' = renderScale fraction; 'target' = absolute pixel dimensions. */
  private scaleMode: 'ratio' | 'target' = 'ratio';
  /** Last committed target render width in pixels (target mode). 0 = unset. */
  private _targetWidth = 0;
  /** Last committed target render height in pixels (target mode). 0 = unset. */
  private _targetHeight = 0;

  // ── Component lifecycle ────────────────────────────────────────────────────

  /**
   * Computes the render scale from an absolute pixel target on one axis,
   * preserving the canvas aspect ratio.  Updates `_targetWidth/_targetHeight`,
   * writes the scale to QualitySettings, and triggers a G-Buffer resize.
   */
  private applyTargetResolution(pixels: number, axis: 'width' | 'height'): void {
    const canvas = Render.canvasSize;
    const axisSize = axis === 'width' ? canvas.width : canvas.height;
    const scale = Math.max(0.25, Math.min(1.0, pixels / axisSize));
    this._targetWidth = Math.round(canvas.width * scale);
    this._targetHeight = Math.round(canvas.height * scale);
    QualitySettings.getInstance().setRenderResolution(scale);
    Render.applyRenderResolution();
  }

  /**
   * Called by the ECS loader with the JSON component data.
   * Applies renderScale to QualitySettings (and immediately triggers a
   * Render.applyRenderResolution() so the G-Buffer is recreated at the
   * correct size), then initialises all GPU resources.
   */
  public async load(data: FSRComponentData = {}): Promise<void> {
    // ── Apply JSON settings before creating GPU resources ──────────────────
    if (data.enabled !== undefined) this.enabled = data.enabled;
    if (data.enableRCAS !== undefined) this.enableRCAS = data.enableRCAS;
    if (data.rcasSharpness !== undefined) this.rcasSharpness = data.rcasSharpness;

    if (data.targetWidth !== undefined || data.targetHeight !== undefined) {
      // Target-resolution mode: derive scale from absolute pixel dimensions.
      this.scaleMode = 'target';
      if (data.targetWidth !== undefined) {
        this.applyTargetResolution(data.targetWidth, 'width');
      } else {
        this.applyTargetResolution(data.targetHeight!, 'height');
      }
    } else if (data.renderScale !== undefined) {
      // Ratio mode: scale is a fraction of canvas resolution.
      this.scaleMode = 'ratio';
      const scale = Math.max(0.25, Math.min(1.0, data.renderScale));
      QualitySettings.getInstance().setRenderResolution(scale);
      Render.applyRenderResolution();
    }

    this.device = Render.getInstance().getDevice();

    await this.loadShaders();
    this.createLayouts();
    this.createParamsBuffers();
    this.createPipelines();
    this.createParamsBindGroups();
    this.createRenderTargets();
    this.createResizableBindGroups();

    const canvas = Render.canvasSize;
    this.dispatchX = Math.ceil(canvas.width / 8);
    this.dispatchY = Math.ceil(canvas.height / 8);

    this.isLoaded = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run EASU (and optionally RCAS) upscaling.
   * @param inputView       The LDR (post tone-mapping) texture view at render resolution.
   * @param externalEncoder When provided, compute passes are recorded into this encoder
   *                        and the caller is responsible for submitting it.  When omitted
   *                        a private encoder is created and submitted immediately.
   * @returns               Final upscaled texture view at canvas resolution.
   */
  public apply(inputView: GPUTextureView, externalEncoder?: GPUCommandEncoder): GPUTextureView {
    if (!this.isLoaded || !this.enabled) return inputView;

    const canvas = Render.canvasSize;
    const isNativeRes = Render.width === canvas.width && Render.height === canvas.height;

    // No upscaling needed and no sharpening requested — skip entirely
    if (isNativeRes && !this.enableRCAS) return inputView;

    // Update RCAS params only when sharpness changes (it's a user setting, not per-frame)
    if (this.rcasSharpness !== this.lastRcasSharpness) {
      this.rcasParamsData[0] = this.rcasSharpness;
      this.rcasParamsData[1] = 0;
      this.rcasParamsData[2] = 0;
      this.rcasParamsData[3] = 0;
      this.device.queue.writeBuffer(this.rcasParamsBuffer, 0, this.rcasParamsData);
      this.lastRcasSharpness = this.rcasSharpness;
    }

    // Lazily create / look up input bind group for this view (shared by EASU & RCAS-only paths)
    let easuInputBG = this.easuInputCache.get(inputView);
    if (!easuInputBG) {
      easuInputBG = BindGroupFactory.createBindGroup(
        `fsr_easu_input_${this.easuInputCache.size}`,
        this.inputTexLayout,
        [{ binding: 0, resource: inputView }],
      );
      this.easuInputCache.set(inputView, easuInputBG);
    }

    // Use provided encoder (preferred — avoids a cross-submission pipeline barrier with the
    // preceding render pass) or fall back to a private one.
    const encoder = externalEncoder ?? this.device.createCommandEncoder({ label: 'FSR Encoder' });

    if (!isNativeRes) {
      // EASU pass — only needed when upscaling
      if (this.easuParamsDirty) {
        this.easuParamsData[0] = Render.width;
        this.easuParamsData[1] = Render.height;
        this.easuParamsData[2] = canvas.width;
        this.easuParamsData[3] = canvas.height;
        this.easuParamsData[4] = Render.width / canvas.width;
        this.easuParamsData[5] = Render.height / canvas.height;
        this.easuParamsData[6] = 1.0 / Render.width;
        this.easuParamsData[7] = 1.0 / Render.height;
        this.device.queue.writeBuffer(this.easuParamsBuffer, 0, this.easuParamsData);
        this.easuParamsDirty = false;
      }
      const easuTs = GPUProfiler.getInstance().getTimestampWrites('FSR EASU');
      const easuPass = encoder.beginComputePass({
        label: 'FSR EASU',
        ...(easuTs && { timestampWrites: easuTs }),
      });
      easuPass.setPipeline(this.easuPipeline);
      easuPass.setBindGroup(0, easuInputBG);
      easuPass.setBindGroup(1, this.easuOutputBindGroup);
      easuPass.setBindGroup(2, this.easuParamsBindGroup);
      easuPass.dispatchWorkgroups(this.dispatchX, this.dispatchY, 1);
      easuPass.end();
    }

    if (this.enableRCAS) {
      // RCAS pass: reads from easuResult after upscaling, or directly from inputView at native res
      const rcasInputBG = isNativeRes ? easuInputBG : this.rcasInputBindGroup;
      const rcasTs = GPUProfiler.getInstance().getTimestampWrites('FSR RCAS');
      const rcasPass = encoder.beginComputePass({
        label: 'FSR RCAS',
        ...(rcasTs && { timestampWrites: rcasTs }),
      });
      rcasPass.setPipeline(this.rcasPipeline);
      rcasPass.setBindGroup(0, rcasInputBG);
      rcasPass.setBindGroup(1, this.rcasOutputBindGroup);
      rcasPass.setBindGroup(2, this.rcasParamsBindGroup);
      rcasPass.dispatchWorkgroups(this.dispatchX, this.dispatchY, 1);
      rcasPass.end();
    }

    // Only submit when we own the encoder
    if (!externalEncoder) {
      this.device.queue.submit([encoder.finish()]);
    }

    return this.enableRCAS ? this.rcasResult.getView() : this.easuResult.getView();
  }

  /** Recreate render targets when the canvas / render resolution changes. */
  public resize(): void {
    if (!this.isLoaded) return;

    this.easuInputCache.clear();
    this.lastRcasSharpness = NaN; // force re-upload after buffer recreation
    this.easuParamsDirty = true;

    const canvas = Render.canvasSize;
    this.dispatchX = Math.ceil(canvas.width / 8);
    this.dispatchY = Math.ceil(canvas.height / 8);

    this.createRenderTargets();
    this.createResizableBindGroups();
  }

  public hasLoaded(): boolean {
    return this.isLoaded;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async loadShaders(): Promise<void> {
    const [easuRes, rcasRes] = await Promise.all([
      ResourceManager.fetch('assets/shaders/post-processing/fsr_easu.compute.wgsl'),
      ResourceManager.fetch('assets/shaders/post-processing/fsr_rcas.compute.wgsl'),
    ]);

    this.easuShader = this.device.createShaderModule({
      label: 'FSR EASU Compute Shader',
      code: await easuRes.text(),
    });

    this.rcasShader = this.device.createShaderModule({
      label: 'FSR RCAS Compute Shader',
      code: await rcasRes.text(),
    });
  }

  private createLayouts(): void {
    // Group 0 — input texture (same layout for both EASU and RCAS)
    this.inputTexLayout = BindGroupFactory.getLayout('fsr_input_tex', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
    ]);

    // Group 1 — storage output texture (write-only rgba16float)
    this.storageTexLayout = BindGroupFactory.getLayout('fsr_storage_tex', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
        },
      },
    ]);

    // Group 2 — params uniform buffer
    this.paramsLayout = BindGroupFactory.getLayout('fsr_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  private createParamsBuffers(): void {
    // EASU params: [inputW, inputH, outputW, outputH, scaleX, scaleY, invW, invH] — 32 bytes
    this.easuParamsBuffer = GPUUtils.createBuffer(
      'fsr_easu_params',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // RCAS params: [sharpness, _pad, _pad, _pad] — 16 bytes
    this.rcasParamsBuffer = GPUUtils.createBuffer(
      'fsr_rcas_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Write sensible defaults
    const canvas = Render.canvasSize;
    this.device.queue.writeBuffer(
      this.easuParamsBuffer,
      0,
      new Float32Array([
        Render.width,
        Render.height,
        canvas.width,
        canvas.height,
        Render.width / canvas.width,
        Render.height / canvas.height,
        1.0 / Render.width,
        1.0 / Render.height,
      ]),
    );
    this.device.queue.writeBuffer(
      this.rcasParamsBuffer,
      0,
      new Float32Array([this.rcasSharpness, 0, 0, 0]),
    );
  }

  private createPipelines(): void {
    const sharedLayouts = [this.inputTexLayout, this.storageTexLayout, this.paramsLayout];

    const easuConfig: ComputePipelineConfig = {
      label: 'FSR EASU Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('fsr_easu_pipeline_layout', sharedLayouts),
      compute: {
        module: this.easuShader,
        entryPoint: 'cs_easu',
      },
    };
    this.easuPipeline = PipelineFactory.createComputePipeline(easuConfig);

    const rcasConfig: ComputePipelineConfig = {
      label: 'FSR RCAS Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('fsr_rcas_pipeline_layout', sharedLayouts),
      compute: {
        module: this.rcasShader,
        entryPoint: 'cs_rcas',
      },
    };
    this.rcasPipeline = PipelineFactory.createComputePipeline(rcasConfig);
  }

  private createParamsBindGroups(): void {
    this.easuParamsBindGroup = BindGroupFactory.createBindGroup(
      'fsr_easu_params_bg',
      this.paramsLayout,
      [{ binding: 0, resource: { buffer: this.easuParamsBuffer } }],
    );

    this.rcasParamsBindGroup = BindGroupFactory.createBindGroup(
      'fsr_rcas_params_bg',
      this.paramsLayout,
      [{ binding: 0, resource: { buffer: this.rcasParamsBuffer } }],
    );
  }

  private createRenderTargets(): void {
    const canvas = Render.canvasSize;
    const format = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.easuResult = new RenderTarget();
    this.easuResult.createRT(
      'fsr_easu_result',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.STORAGE_BINDING,
    );

    this.rcasResult = new RenderTarget();
    this.rcasResult.createRT(
      'fsr_rcas_result',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.STORAGE_BINDING,
    );
  }

  /**
   * Build the bind groups that reference render target views.
   * Must be called after createRenderTargets() — and again after every resize.
   */
  private createResizableBindGroups(): void {
    // EASU writes to easuResult
    this.easuOutputBindGroup = BindGroupFactory.createBindGroup(
      'fsr_easu_output_bg',
      this.storageTexLayout,
      [{ binding: 0, resource: this.easuResult.getStorageView() }],
    );

    // RCAS reads from easuResult
    this.rcasInputBindGroup = BindGroupFactory.createBindGroup(
      'fsr_rcas_input_bg',
      this.inputTexLayout,
      [{ binding: 0, resource: this.easuResult.getView() }],
    );

    // RCAS writes to rcasResult
    this.rcasOutputBindGroup = BindGroupFactory.createBindGroup(
      'fsr_rcas_output_bg',
      this.storageTexLayout,
      [{ binding: 0, resource: this.rcasResult.getStorageView() }],
    );
  }

  // ── Debug UI ───────────────────────────────────────────────────────────────

  // Live read-only stats shown in the GUI
  private debugStats = {
    input: '?x?',
    output: '?x?',
    scale: '?x',
  };

  // Proxy so lil-gui can read/write renderResolution through QualitySettings
  private readonly renderResProxy = {
    get resolution() {
      return QualitySettings.getInstance().getSettings().renderResolution;
    },
    set resolution(v: number) {
      QualitySettings.getInstance().setRenderResolution(v);
      Render.applyRenderResolution();
    },
  };

  // Mutable object holding the mode dropdown value (synced each frame)
  private readonly modeControl = { scaleMode: 'ratio' as 'ratio' | 'target' };

  // Editable target pixel dimensions (target mode).  Updated on GUI change and on
  // first entry into target mode.
  private readonly targetInput = { width: 0, height: 0 };
  private _targetSyncNeeded = true;

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (!gui.beginWindow('FSR 1.0', true)) return;

    const folder = (gui as any).folders?.get('FSR 1.0');
    if (!folder) {
      gui.endWindow();
      return;
    }

    // Update live stats every frame
    const canvas = Render.canvasSize;
    this.debugStats.input = `${Render.width} × ${Render.height}`;
    this.debugStats.output = `${canvas.width} × ${canvas.height}`;
    const scaleX = canvas.width / Math.max(Render.width, 1);
    const scaleY = canvas.height / Math.max(Render.height, 1);
    this.debugStats.scale = `${scaleX.toFixed(2)}x (${scaleY.toFixed(2)}x)`;

    folder.add(this.debugStats, 'input').name('Input  (render res)').listen().disable();
    folder.add(this.debugStats, 'output').name('Output (canvas res)').listen().disable();
    folder.add(this.debugStats, 'scale').name('Upscale factor').listen().disable();

    folder.add(this, 'enabled').name('Enable FSR').listen();
    folder.add(this, 'enableRCAS').name('Enable RCAS Sharpening').listen();
    folder.add(this, 'rcasSharpness', 0.0, 2.0, 0.05).name('RCAS Sharpness').listen();

    // Scale mode selector
    this.modeControl.scaleMode = this.scaleMode;
    folder
      .add(this.modeControl, 'scaleMode', ['ratio', 'target'])
      .name('Scale Mode')
      .listen()
      .onChange((v: 'ratio' | 'target') => {
        this.scaleMode = v;
        this._targetSyncNeeded = true;
      });

    if (this.scaleMode === 'ratio') {
      folder
        .add(this.renderResProxy, 'resolution', 0.25, 1.0, 0.05)
        .name('Render Resolution')
        .listen();
    } else {
      // Initialise target inputs from actual render dimensions on first entry
      if (this._targetSyncNeeded) {
        this.targetInput.width = this._targetWidth > 0 ? this._targetWidth : Render.width;
        this.targetInput.height = this._targetHeight > 0 ? this._targetHeight : Render.height;
        this._targetSyncNeeded = false;
      }

      folder
        .add(this.targetInput, 'width', 1, canvas.width, 1)
        .name('Target Width (px)')
        .listen()
        .onChange((v: number) => {
          const c = Render.canvasSize;
          const scale = Math.max(0.25, Math.min(1.0, v / c.width));
          this._targetWidth = Math.round(c.width * scale);
          this._targetHeight = Math.round(c.height * scale);
          this.targetInput.width = this._targetWidth;
          this.targetInput.height = this._targetHeight;
          QualitySettings.getInstance().setRenderResolution(scale);
          Render.applyRenderResolution();
        });

      folder
        .add(this.targetInput, 'height', 1, canvas.height, 1)
        .name('Target Height (px)')
        .listen()
        .onChange((v: number) => {
          const c = Render.canvasSize;
          const scale = Math.max(0.25, Math.min(1.0, v / c.height));
          this._targetWidth = Math.round(c.width * scale);
          this._targetHeight = Math.round(c.height * scale);
          this.targetInput.width = this._targetWidth;
          this.targetInput.height = this._targetHeight;
          QualitySettings.getInstance().setRenderResolution(scale);
          Render.applyRenderResolution();
        });
    }

    gui.endWindow();
  }

  public debugInMenu(): void {}
  public renderDebug(): void {}
  public update(_dt: number): void {}

  // ── Cleanup ────────────────────────────────────────────────────────────────

  public dispose(): void {
    this.easuParamsBuffer?.destroy();
    this.rcasParamsBuffer?.destroy();
    this.easuInputCache.clear();
  }
}
