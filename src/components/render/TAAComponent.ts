import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import {
  TemporalResolvePass,
  TemporalResolveSettings,
} from '../../renderer/core/passes/TemporalResolvePass';

/** Optional prefab data (`"taa": { ... }`). Omitted fields keep the three.js defaults. */
export interface TAAComponentData {
  currentFrameWeight?: number;
  depthThreshold?: number;
  edgeDepthDiff?: number;
  maxVelocityLength?: number;
  useSubpixelCorrection?: boolean;
}

/**
 * TAAComponent — Temporal Anti-Aliasing (port of three.js TRAANode, see taa.cs).
 *
 * Runs at render resolution, BEFORE tone mapping (HDR linear). Requires camera jitter and
 * the velocity buffer, both enabled automatically by ModuleRender when this component is
 * on the MainCamera.
 */
export class TAAComponent extends Component {
  private loaded = false;
  private pass = new TemporalResolvePass('TAA Resolve', 'post-processing/taa.cs', () => ({
    width: Render.width,
    height: Render.height,
  }));

  private taaParams = {
    enabled: true,
    // three.js TRAANode defaults; depth thresholds are relative (linear depth)
    currentFrameWeight: 0.05,
    depthThreshold: 0.01,
    edgeDepthDiff: 0.05,
    maxVelocityLength: 128,
    useSubpixelCorrection: true,
  };

  constructor() {
    super();
  }

  public async load(data: TAAComponentData = {}): Promise<void> {
    Object.assign(
      this.taaParams,
      Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    );
    await this.pass.load();
    this.loaded = true;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  /** Previous frame's resolved result (stable, jitter-free), or null without history. */
  public getHistoryView(): GPUTextureView | null {
    if (!this.loaded || !this.taaParams.enabled || !this.pass.isHistoryValid()) return null;
    return this.pass.getHistoryView();
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'taa', (comp) => {
      const c = comp as TAAComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (this.loaded) this.pass.createTargets();
  }

  /**
   * @param inputTexture current HDR frame (render resolution)
   * @param linearDepth  G-buffer linear depth target (render resolution)
   */
  public apply(inputTexture: GPUTextureView, linearDepth: RenderTarget): GPUTextureView {
    if (!this.loaded || !this.taaParams.enabled) {
      this.pass.resetHistory();
      return inputTexture;
    }
    const settings: TemporalResolveSettings = this.taaParams;
    return this.pass.execute(inputTexture, linearDepth, settings);
  }

  public update(_dt: number): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (this._editorFolder || !parentFolder) return;
    const f = parentFolder.addFolder('TAA');
    this._editorFolder = f;
    f.close();
    f.add(this.taaParams, 'enabled').name('Enabled').listen();
    f.add(this.taaParams, 'currentFrameWeight', 0.01, 0.5, 0.005).name('Current Weight').listen();
    f.add(this.taaParams, 'depthThreshold', 0.001, 0.1, 0.001).name('Disocclusion Thr.').listen();
    f.add(this.taaParams, 'edgeDepthDiff', 0.005, 0.5, 0.005).name('Edge Depth Diff').listen();
    f.add(this.taaParams, 'maxVelocityLength', 8, 512, 1).name('Max Velocity (px)').listen();
    f.add(this.taaParams, 'useSubpixelCorrection').name('Subpixel Correction').listen();
  }

  public debugInMenu(): void {}
  public override renderDebug(): void {}

  public override dispose(): void {
    this.pass.destroy();
  }
}
