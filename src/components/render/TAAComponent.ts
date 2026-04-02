import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { VelocityBufferManager } from '../../renderer/core/managers/VelocityBufferManager';

/**
 * TAAComponent — Temporal Anti-Aliasing
 *
 * Must be placed BEFORE tone mapping in the post-processing chain so that
 * accumulation happens in HDR linear space.
 *
 * Pipeline: HDR result → TAA → (tone mapping) → FSR/present
 *
 * Depends on:
 *  - Camera jittering (enabled automatically by ModuleRender when this component is present)
 *  - VelocityBufferManager (enabled automatically by ModuleRender)
 *  - G-Buffer linear depth (passed to apply())
 *
 * Ping-pong history:  finalRT is always the output; after each frame its content
 * is copied into historyRT so the next frame can read it as "history".
 */
export class TAAComponent extends Component {
  private loaded = false;
  private device!: GPUDevice;

  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  // Output render target (written every frame, COPY_SRC so we can copy to history)
  private finalRT!: RenderTarget;
  // History buffer — receives a GPU copy of finalRT at end of each frame (COPY_DST)
  private historyRT!: RenderTarget;

  // Blank 1×1 textures used as velocity/depth placeholders on first-frame seed
  private blankVelocityTexture!: GPUTexture;
  private blankDepthTexture!: GPUTexture;

  // GPU uniform buffers for TAAParams
  private paramsBuffer!: GPUBuffer;
  private seedParamsBuffer!: GPUBuffer; // blendFactor=1 → 100% current (no history blend)
  private paramsData = new Float32Array(4); // [blendFactor, sharpenStrength, gamma, _pad]

  // Cached bind groups — invalidated on resize
  // NOTE: textures bind group is NOT cached because GPUTextureView objects all
  // stringify to "[object GPUTextureView]", making Map keys indistinguishable.
  // Bind group creation is cheap; recreating every resolve pass is correct & safe.
  private paramsBindGroupCached: GPUBindGroup | null = null;
  private seedParamsBindGroupCached: GPUBindGroup | null = null;

  // On first frame there is no valid history — seed historyRT with current frame
  private isFirstFrame = true;

  // TAA parameters exposed in debug UI
  private taaParams = {
    enabled: true,
    blendFactor: 0.1, // base blend toward current frame (0.1 = 90% history at rest)
    sharpenStrength: 0.0, // unsharp-mask post-blend sharpening (0 = off)
    gamma: 1.25, // variance AABB std-dev multiplier (1.0–1.5)
  };

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    this.device = Render.getInstance().getDevice();

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/taa.tech');

    const format = QualitySettings.getInstance().getSettings().hdrTexture;

    this.paramsBuffer = this.device.createBuffer({
      label: 'taa_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.seedParamsBuffer = this.device.createBuffer({
      label: 'taa_seed_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Seed params: blendFactor=1 so resolve = 100% current (no history influence)
    this.device.queue.writeBuffer(this.seedParamsBuffer, 0, new Float32Array([1.0, 0.0, 1.0, 0.0]));

    // Blank 1×1 textures used as velocity/depth placeholders on first-frame seed
    const blankDesc: GPUTextureDescriptor = {
      size: [1, 1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    this.blankVelocityTexture = this.device.createTexture({
      ...blankDesc,
      label: 'taa_blank_velocity',
    });
    this.blankDepthTexture = this.device.createTexture({ ...blankDesc, label: 'taa_blank_depth' });

    this.finalRT = new RenderTarget();
    this.finalRT.createRT(
      'taa_final',
      Render.width,
      Render.height,
      format,
      GPUTextureUsage.COPY_SRC,
    );
    this.historyRT = new RenderTarget();
    this.historyRT.createRT(
      'taa_history',
      Render.width,
      Render.height,
      format,
      GPUTextureUsage.COPY_DST,
    );

    this.loaded = true;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Returns the TAA-resolved result from the previous frame — stable, no jitter,
   * temporally accumulated. Ideal for SSR hit-color sampling instead of the
   * current jittered accLight.
   *
   * Returns null when there is no valid history yet (first frame, not loaded,
   * or TAA disabled) so callers can fall back to accLight.
   */
  public getHistoryView(): GPUTextureView | null {
    if (!this.loaded || this.isFirstFrame || !this.taaParams.enabled) return null;
    return this.historyRT.getView();
  }

  public resize(): void {
    if (!this.loaded) return;

    const format = QualitySettings.getInstance().getSettings().hdrTexture;
    this.finalRT.createRT(
      'taa_final',
      Render.width,
      Render.height,
      format,
      GPUTextureUsage.COPY_SRC,
    );
    this.historyRT.createRT(
      'taa_history',
      Render.width,
      Render.height,
      format,
      GPUTextureUsage.COPY_DST,
    );

    // Reset history state — next frame will be treated as first frame
    this.isFirstFrame = true;
    this.paramsBindGroupCached = null;
    this.seedParamsBindGroupCached = null;
  }

  /**
   * Apply TAA to the input HDR texture.
   *
   * @param inputTexture    current HDR frame (output of DeferredRenderer/SSR composite)
   * @param linearDepthView G-Buffer linear depth (from DeferredRenderer.getLinearDepthView())
   * @returns GPUTextureView of the temporally accumulated result
   */
  public apply(inputTexture: GPUTextureView, linearDepthView: GPUTextureView): GPUTextureView {
    if (!this.loaded || !this.taaParams.enabled) {
      return inputTexture;
    }

    if (this.isFirstFrame) {
      // Seed the history buffer with the current frame so frame 2 has a valid
      // (non-black) history.  blendFactor=1 → result = 100% current frame.
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
    // Always create a fresh bind group — the textures change content every frame
    // and GPUTextureView identity cannot serve as a reliable cache key.
    const texturesBG = BindGroupFactory.createBindGroup(
      'taa_textures_bg',
      this.technique.getPipeline().getBindGroupLayout(0),
      [
        { binding: 0, resource: SamplerLibrary.simpleSampler },
        { binding: 1, resource: current },
        { binding: 2, resource: history },
        { binding: 3, resource: velocity },
        { binding: 4, resource: linearDepth },
      ],
    );

    const encoder = Render.getInstance().getCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'TAA Resolve',
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
    pass.setBindGroup(0, texturesBG);
    pass.setBindGroup(1, paramsBindGroup);
    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  private copyToHistory(): void {
    const src = this.finalRT.getTexture();
    const dst = this.historyRT.getTexture();
    if (!src || !dst) return;
    Render.getInstance()
      .getCommandEncoder()
      .copyTextureToTexture({ texture: src }, { texture: dst }, [Render.width, Render.height, 1]);
  }

  // ── Bind groups ────────────────────────────────────────────────────────────

  private getParamsBindGroup(): GPUBindGroup {
    if (!this.paramsBindGroupCached) {
      this.paramsBindGroupCached = BindGroupFactory.createBindGroup(
        'taa_params_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(1),
        [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
      );
    }
    return this.paramsBindGroupCached;
  }

  private getSeedParamsBindGroup(): GPUBindGroup {
    if (!this.seedParamsBindGroupCached) {
      this.seedParamsBindGroupCached = BindGroupFactory.createBindGroup(
        'taa_seed_params_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(1),
        [{ binding: 0, resource: { buffer: this.seedParamsBuffer } }],
      );
    }
    return this.seedParamsBindGroupCached;
  }

  private uploadParamsIfDirty(): void {
    // Always upload — GUI edits mutate taaParams directly with no onChange hook.
    // 16-byte writeBuffer is negligible cost.
    this.paramsData[0] = this.taaParams.blendFactor;
    this.paramsData[1] = this.taaParams.sharpenStrength;
    this.paramsData[2] = this.taaParams.gamma;
    this.paramsData[3] = 0.0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  // ── Component lifecycle ────────────────────────────────────────────────────

  public update(_dt: number): void {}

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (!gui.beginWindow('TAA', true)) return;

    const folder = (gui as any).folders?.get('TAA');
    if (!folder) {
      gui.endWindow();
      return;
    }

    folder.add(this.taaParams, 'enabled').name('Enabled').listen();
    folder.add(this.taaParams, 'blendFactor', 0.01, 0.5, 0.01).name('Blend Factor').listen();
    folder.add(this.taaParams, 'gamma', 0.5, 2.0, 0.05).name('Clamp Gamma').listen();
    folder.add(this.taaParams, 'sharpenStrength', 0.0, 1.0, 0.05).name('Sharpen Strength').listen();

    gui.endWindow();
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
