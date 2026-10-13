import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import {
  TemporalResolvePass,
  TemporalResolveSettings,
} from '../../renderer/core/passes/TemporalResolvePass';
import { TSRComponentData } from '../../types/TSRComponentData.type';

/**
 * TSRComponent — Temporal Super-Resolution (port of three.js TAAUNode, see tsr.cs).
 *
 * Renders the scene at `renderScale` × canvas resolution and reconstructs the canvas
 * resolution output from the jittered samples of successive frames. Replaces TAA (and
 * FSR) in the chain; runs BEFORE tone mapping (HDR linear). Camera jitter, the velocity
 * buffer and the matching texture mip bias are enabled by ModuleRender.
 */
export class TSRComponent extends Component {
  private loaded = false;
  private pass = new TemporalResolvePass('TSR Resolve', 'post-processing/tsr.cs', () => ({
    width: Render.canvasSize.width,
    height: Render.canvasSize.height,
  }));

  private tsrParams = {
    enabled: true,
    // three.js TAAUNode defaults; depth thresholds are relative (linear depth)
    currentFrameWeight: 0.025,
    depthThreshold: 0.01,
    edgeDepthDiff: 0.05,
    maxVelocityLength: 128,
    useSubpixelCorrection: false,
  };

  constructor() {
    super();
  }

  public async load(data: TSRComponentData = {}): Promise<void> {
    if (data.currentFrameWeight !== undefined) this.tsrParams.currentFrameWeight = data.currentFrameWeight;
    if (data.depthThreshold !== undefined) this.tsrParams.depthThreshold = data.depthThreshold;
    if (data.edgeDepthDiff !== undefined) this.tsrParams.edgeDepthDiff = data.edgeDepthDiff;
    if (data.maxVelocityLength !== undefined) this.tsrParams.maxVelocityLength = data.maxVelocityLength;

    if (data.renderScale !== undefined) {
      const scale = Math.max(0.25, Math.min(1.0, data.renderScale));
      QualitySettings.getInstance().setRenderResolution(scale);
      Render.applyRenderResolution();
    }

    await this.pass.load();
    this.loaded = true;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  /** Previous frame's resolved result at canvas resolution, or null without history. */
  public getHistoryView(): GPUTextureView | null {
    if (!this.loaded || !this.tsrParams.enabled || !this.pass.isHistoryValid()) return null;
    return this.pass.getHistoryView();
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'tsr', (comp) => {
      const c = comp as TSRComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (this.loaded) this.pass.createTargets();
  }

  /**
   * @param inputTexture current HDR frame (render resolution)
   * @param linearDepth  G-buffer linear depth target (render resolution)
   * @returns resolved frame at canvas resolution
   */
  public apply(inputTexture: GPUTextureView, linearDepth: RenderTarget): GPUTextureView {
    if (!this.loaded || !this.tsrParams.enabled) {
      this.pass.resetHistory();
      return inputTexture;
    }
    const settings: TemporalResolveSettings = this.tsrParams;
    return this.pass.execute(inputTexture, linearDepth, settings);
  }

  public update(_dt: number): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (this._editorFolder || !parentFolder) return;
    const f = parentFolder.addFolder('TSR');
    this._editorFolder = f;
    f.close();
    f.add(this.tsrParams, 'enabled').name('Enabled').listen();
    f.add(this.tsrParams, 'currentFrameWeight', 0.005, 0.5, 0.005).name('Current Weight').listen();
    f.add(this.tsrParams, 'depthThreshold', 0.001, 0.1, 0.001).name('Disocclusion Thr.').listen();
    f.add(this.tsrParams, 'edgeDepthDiff', 0.005, 0.5, 0.005).name('Edge Depth Diff').listen();
    f.add(this.tsrParams, 'maxVelocityLength', 8, 512, 1).name('Max Velocity (px)').listen();
  }

  public debugInMenu(): void {}
  public override renderDebug(): void {}

  public override dispose(): void {
    this.pass.destroy();
  }
}
