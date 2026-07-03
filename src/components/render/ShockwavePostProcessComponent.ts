import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { ShockwavePass, ShockwaveConfig } from '../../renderer/shading/ShockwavePass';

/**
 * Screen-space temporal distortion — Quantum Break style.
 *
 * Attach to the MainCamera entity. Call `spawn()` from any game component
 * to trigger an expanding shockwave from a world-space origin.
 *
 * Example:
 *   const sw = camera.getComponent('shockwave') as ShockwavePostProcessComponent;
 *   sw.spawn([px, py, pz], { speed: 18, intensity: 0.05 });
 */
export class ShockwavePostProcessComponent extends Component {
  private pass: ShockwavePass = new ShockwavePass();
  private _loaded = false;

  // Default config exposed in the debug menu — sliders modify these,
  // and they become the defaults for the next spawn() call.
  private debugConfig = {
    speed:     14.0,
    maxRadius: 20.0,
    thickness:  2.0,
    intensity:  0.04,
    falloff:    0.6,
  };

  // ── Message subscriptions ────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'shockwave', (comp) => {
      const c = comp as ShockwavePostProcessComponent;
      if (c.hasLoaded()) c.pass.resize();
    });
  }

  // ── Component lifecycle ──────────────────────────────────────────────────

  public load(_data: unknown): void {
    // async load is kicked off in onAttach so the entity is available
  }

  public override async onAttach(): Promise<void> {
    await this.pass.load();
    this._loaded = true;
  }

  public update(dt: number): void {
    if (!this._loaded) return;
    this.pass.update(dt);
  }

  public renderDebug(): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (!parentFolder || this._editorFolder) return;

    const f = parentFolder.addFolder('Shockwave');
    f.close();   // start collapsed

    // Live counters
    const stats = { activeWaves: 0 };
    f.add(stats, 'activeWaves').name('Active Waves').listen();
    // Refresh counter each frame via the folder's onChange — lil-gui listen() handles it
    // by reading the property each animation frame. We proxy it through a getter object.
    Object.defineProperty(stats, 'activeWaves', {
      get: () => this.pass.getActiveWaveCount(),
      enumerable: true,
    });

    f.add(this.debugConfig, 'speed',      1.0, 40.0, 0.5 ).name('Speed (m/s)');
    f.add(this.debugConfig, 'maxRadius',  1.0, 60.0, 1.0 ).name('Max Radius (m)');
    f.add(this.debugConfig, 'thickness',  0.1, 10.0, 0.1 ).name('Thickness (m)');
    f.add(this.debugConfig, 'intensity',  0.005, 0.2, 0.005).name('Intensity');
    f.add(this.debugConfig, 'falloff',    0.0,  2.0, 0.05).name('Falloff');

    f.add({ spawnTest: () => this.pass.addWave([0, 1, 0], { ...this.debugConfig }) }, 'spawnTest')
     .name('Spawn at Origin');

    this._editorFolder = f;
  }

  public override dispose(): void {
    this.pass.dispose();
    this._loaded = false;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  public hasLoaded(): boolean { return this._loaded; }

  /**
   * Spawn a new shockwave centred at `origin` (world space).
   * Safe to call at any time; waves are queued immediately.
   */
  public spawn(
    origin: [number, number, number],
    config: ShockwaveConfig = {},
  ): void {
    this.pass.addWave(origin, config);
  }

  /**
   * Called by ModuleRender each frame.
   * Returns the distorted accLight view, or the original when no waves are active.
   */
  public apply(
    accLightView:     GPUTextureView,
    gLinearDepthView: GPUTextureView,
  ): GPUTextureView {
    if (!this._loaded) return accLightView;
    return this.pass.apply(accLightView, gLinearDepthView);
  }

}
