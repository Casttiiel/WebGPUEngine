import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { VelocityBufferManager } from '../../renderer/core/managers/VelocityBufferManager';
import { TSRComponentData } from '../../types/TSRComponentData.type';

/**
 * TSRComponent — Temporal Super-Resolution / Upscaling
 *
 * Replaces TAAComponent + FSRComponent in the post-processing chain:
 * renders the 3D scene at a lower internal resolution and produces output
 * at full canvas resolution via temporal accumulation with Catmull-Rom
 * reconstruction (spatial upsampling).
 *
 * Pipeline: HDR result (render res) → TSR → (tone mapping at canvas res) → present
 *
 * History and final render targets are always at CANVAS resolution.
 * Input (current frame, velocity, depth) is at RENDER resolution.
 *
 * Depends on:
 *  - Camera jittering (enabled automatically by ModuleRender when this component is present)
 *  - VelocityBufferManager (enabled automatically by ModuleRender)
 *  - G-Buffer linear depth (passed to apply())
 */
export class TSRComponent extends Component {
  private loaded = false;
  private device!: GPUDevice;

  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  // Output render target at CANVAS resolution (COPY_SRC so we can copy to history)
  private finalRT!: RenderTarget;
  // History buffer at CANVAS resolution (receives GPU copy of finalRT each frame)
  private historyRT!: RenderTarget;

  // Blank 1×1 textures used as velocity/depth placeholders on first-frame seed
  private blankVelocityTexture!: GPUTexture;
  private blankDepthTexture!: GPUTexture;

  // GPU uniform buffer for TSRParams
  private paramsBuffer!: GPUBuffer;
  private seedParamsBuffer!: GPUBuffer; // blendFactor=1 → 100% current (no history blend)
  private paramsData = new Float32Array(4); // [blendFactor, sharpenStrength, gamma, _pad]

  // Cached bind groups — invalidated on resize
  private paramsBindGroupCached: GPUBindGroup | null = null;
  private seedParamsBindGroupCached: GPUBindGroup | null = null;
  // Cached textures bind group — invalidated when any input view pointer changes
  private texturesBGCached: GPUBindGroup | null = null;
  private lastTSRCurrent: GPUTextureView | null = null;
  private lastTSRHistory: GPUTextureView | null = null;
  private lastTSRVelocity: GPUTextureView | null = null;
  private lastTSRDepth: GPUTextureView | null = null;

  // First-frame guard: seed historyRT with current frame so frame 2 has valid history
  private isFirstFrame = true;

  // TSR parameters
  private tsrParams = {
    enabled: true,
    blendFactor: 0.1,
    sharpenStrength: 0.0,
    gamma: 1.25,
  };

  constructor() {
    super();
  }

  public async load(data: TSRComponentData = {}): Promise<void> {
    // Apply JSON config before creating GPU resources
    if (data.blendFactor !== undefined) this.tsrParams.blendFactor = data.blendFactor;
    if (data.sharpenStrength !== undefined) this.tsrParams.sharpenStrength = data.sharpenStrength;
    if (data.gamma !== undefined) this.tsrParams.gamma = data.gamma;

    if (data.renderScale !== undefined) {
      const scale = Math.max(0.25, Math.min(1.0, data.renderScale));
      QualitySettings.getInstance().setRenderResolution(scale);
      Render.applyRenderResolution();
    }

    this.device = Render.getInstance().getDevice();

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/tsr.tech');

    const format = QualitySettings.getInstance().getSettings().hdrTexture;

    this.paramsBuffer = this.device.createBuffer({
      label: 'tsr_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.seedParamsBuffer = this.device.createBuffer({
      label: 'tsr_seed_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Seed params: blendFactor=1 → 100% current frame, no history influence
    this.device.queue.writeBuffer(this.seedParamsBuffer, 0, new Float32Array([1.0, 0.0, 1.0, 0.0]));

    // Blank 1×1 textures for first-frame velocity/depth placeholders
    const blankDesc: GPUTextureDescriptor = {
      size: [1, 1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    this.blankVelocityTexture = this.device.createTexture({
      ...blankDesc,
      label: 'tsr_blank_velocity',
    });
    this.blankDepthTexture = this.device.createTexture({
      ...blankDesc,
      label: 'tsr_blank_depth',
    });

    // Both RTs live at CANVAS resolution — TSR outputs full-res directly
    const canvas = Render.canvasSize;
    this.finalRT = new RenderTarget();
    this.finalRT.createRT(
      'tsr_final',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.COPY_SRC,
    );
    this.historyRT = new RenderTarget();
    this.historyRT.createRT(
      'tsr_history',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.COPY_DST,
    );

    this.loaded = true;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Returns the TSR-resolved history view — stable, jitter-free, temporally
   * accumulated at canvas resolution.  Useful for SSR hit-colour sampling
   * in place of the jittered accLight buffer.
   *
   * Returns null on first frame or when disabled.
   */
  public getHistoryView(): GPUTextureView | null {
    if (!this.loaded || this.isFirstFrame || !this.tsrParams.enabled) return null;
    return this.historyRT.getView();
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'tsr', (comp) => {
      const c = comp as TSRComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;

    const format = QualitySettings.getInstance().getSettings().hdrTexture;
    // NOTE: resize always uses CANVAS size, not render size.
    const canvas = Render.canvasSize;
    this.finalRT.createRT(
      'tsr_final',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.COPY_SRC,
    );
    this.historyRT.createRT(
      'tsr_history',
      canvas.width,
      canvas.height,
      format,
      GPUTextureUsage.COPY_DST,
    );

    this.isFirstFrame = true;
    this.paramsBindGroupCached = null;
    this.seedParamsBindGroupCached = null;
    this.texturesBGCached = null;
    this.lastTSRCurrent = null;
    this.lastTSRHistory = null;
    this.lastTSRVelocity = null;
    this.lastTSRDepth = null;
  }

  /**
   * Apply TSR to the input HDR texture.
   *
   * @param inputTexture    Current HDR frame at render resolution
   * @param linearDepthView G-Buffer linear depth (render resolution)
   * @returns GPUTextureView of the temporally accumulated result at canvas resolution
   */
  public apply(inputTexture: GPUTextureView, linearDepthView: GPUTextureView): GPUTextureView {
    if (!this.loaded || !this.tsrParams.enabled) {
      return inputTexture;
    }

    if (this.isFirstFrame) {
      // Seed history with current frame (blendFactor=1 → pure current, no blend)
      this.runResolvePass(
        inputTexture,
        inputTexture,
        this.blankVelocityTexture.createView(),
        this.blankDepthTexture.createView(),
        this.getSeedParamsBindGroup(),
      );
      this.copyToHistory();
      this.isFirstFrame = false;
      return this.finalRT.getView();
    }

    this.uploadParamsIfDirty();

    const velocityView = VelocityBufferManager.getInstance().getVelocityTextureView();
    this.runResolvePass(
      inputTexture,
      this.historyRT.getView(),
      velocityView,
      linearDepthView,
      this.getParamsBindGroup(),
    );
    this.copyToHistory();

    return this.finalRT.getView();
  }

  // ── Core render pass ───────────────────────────────────────────────────────

  private runResolvePass(
    current: GPUTextureView,
    history: GPUTextureView,
    velocity: GPUTextureView,
    linearDepth: GPUTextureView,
    paramsBindGroup: GPUBindGroup,
  ): void {
    if (
      !this.texturesBGCached ||
      this.lastTSRCurrent !== current ||
      this.lastTSRHistory !== history ||
      this.lastTSRVelocity !== velocity ||
      this.lastTSRDepth !== linearDepth
    ) {
      this.texturesBGCached = BindGroupFactory.createBindGroup(
        'tsr_textures_bg',
        this.technique.getPipeline().getBindGroupLayout(0),
        [
          { binding: 0, resource: SamplerLibrary.simpleSampler },
          { binding: 1, resource: current },
          { binding: 2, resource: history },
          { binding: 3, resource: velocity },
          { binding: 4, resource: linearDepth },
        ],
      );
      this.lastTSRCurrent = current;
      this.lastTSRHistory = history;
      this.lastTSRVelocity = velocity;
      this.lastTSRDepth = linearDepth;
    }

    const encoder = Render.getInstance().getCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'TSR Resolve',
      colorAttachments: [
        {
          view: this.finalRT.getRenderView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.technique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);
    pass.setBindGroup(0, this.texturesBGCached!);
    pass.setBindGroup(1, paramsBindGroup);
    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  private copyToHistory(): void {
    const src = this.finalRT.getTexture();
    const dst = this.historyRT.getTexture();
    if (!src || !dst) return;
    const canvas = Render.canvasSize;
    Render.getInstance()
      .getCommandEncoder()
      .copyTextureToTexture({ texture: src }, { texture: dst }, [canvas.width, canvas.height, 1]);
  }

  // ── Bind groups ────────────────────────────────────────────────────────────

  private getParamsBindGroup(): GPUBindGroup {
    if (!this.paramsBindGroupCached) {
      this.paramsBindGroupCached = BindGroupFactory.createBindGroup(
        'tsr_params_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(1),
        [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
      );
    }
    return this.paramsBindGroupCached;
  }

  private getSeedParamsBindGroup(): GPUBindGroup {
    if (!this.seedParamsBindGroupCached) {
      this.seedParamsBindGroupCached = BindGroupFactory.createBindGroup(
        'tsr_seed_params_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(1),
        [{ binding: 0, resource: { buffer: this.seedParamsBuffer } }],
      );
    }
    return this.seedParamsBindGroupCached;
  }

  private uploadParamsIfDirty(): void {
    this.paramsData[0] = this.tsrParams.blendFactor;
    this.paramsData[1] = this.tsrParams.sharpenStrength;
    this.paramsData[2] = this.tsrParams.gamma;
    this.paramsData[3] = 0.0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  // ── Component lifecycle ────────────────────────────────────────────────────

  public update(_dt: number): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (!parentFolder) return;
    const f = parentFolder.addFolder('TSR');
    f.close();
    f.add(this.tsrParams, 'enabled').name('Enabled').listen();
    f.add(this.tsrParams, 'blendFactor', 0.01, 0.5, 0.01).name('Blend Factor').listen();
    f.add(this.tsrParams, 'gamma', 0.5, 2.0, 0.05).name('Clamp Gamma').listen();
    f.add(this.tsrParams, 'sharpenStrength', 0.0, 1.0, 0.05).name('Sharpen Strength').listen();
  }

  public debugInMenu(): void {}
  public renderDebug(): void {}

  public override dispose(): void {
    this.finalRT?.destroy();
    this.historyRT?.destroy();
    this.paramsBuffer?.destroy();
    this.seedParamsBuffer?.destroy();
    this.blankVelocityTexture?.destroy();
    this.blankDepthTexture?.destroy();
  }
}
