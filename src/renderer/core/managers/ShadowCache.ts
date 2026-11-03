import { Camera } from '../../../core/math/Camera';
import { GPUProfiler } from '../../../core/debug/GPUProfiler';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Render } from '../pipeline/Render';
import { GPUUtils } from '../utils/GPUUtils';
import { RenderManagerV2 } from './RenderManagerV2';

/**
 * Static-caster cache of one shadow map (a spot light, the 6 faces of a point light, one CSM
 * cascade). The static casters (RenderManagerV2.isStaticShadowCaster) are drawn once into a
 * private copy; every frame that copy is copied into the live map and only the movable casters
 * are drawn on top (depth test → same result as drawing everything). The copy is redrawn when
 * the light's signature (position, matrices, range…) or the set of static casters changes.
 * When no movable caster touches the light the live map is left alone: no pass at all.
 *
 * The live texture needs COPY_DST; the cache is created to match it (size, layers).
 */
export class ShadowCache {
  /** Off = every light redraws everything every frame (A/B comparisons, debugging). */
  public static enabled = true;

  private texture: GPUTexture | null = null;
  private views: GPUTextureView[] = [];
  private live: GPUTexture | null = null;
  private signature: Float32Array;
  private staticVersion = -1;
  /** Per layer: the live map holds something other than the static copy (movables, or nothing yet). */
  private liveDirty: boolean[] = [];

  constructor(
    private readonly label: string,
    signatureLength: number,
  ) {
    this.signature = new Float32Array(signatureLength).fill(NaN);
  }

  /**
   * Starts a frame: true when the static copy must be redrawn (first use, the live texture
   * changed, the light's signature changed, or static casters were added, removed or moved).
   */
  public begin(live: GPUTexture, signature: ArrayLike<number>): boolean {
    let dirty = false;
    if (this.live !== live || !this.texture) {
      this.createCache(live);
      dirty = true;
    }
    for (let i = 0; i < this.signature.length; i++) {
      if (this.signature[i] !== signature[i]) {
        this.signature[i] = signature[i]!;
        dirty = true;
      }
    }
    const version = RenderManagerV2.getInstance().getStaticShadowVersion();
    if (version !== this.staticVersion) {
      this.staticVersion = version;
      dirty = true;
    }
    return dirty;
  }

  /**
   * Brings one layer of the live map up to date: redraws the static copy when `staticDirty`,
   * copies it into the live layer, then draws the movable casters when `movables`.
   * `camera` is that layer's shadow camera (culled here).
   */
  public renderLayer(
    layer: number,
    camera: Camera,
    liveView: GPUTextureView,
    staticDirty: boolean,
    movables: boolean,
    timestampLabel: string,
  ): void {
    if (!staticDirty && !movables && !this.liveDirty[layer]) return;
    const rm = RenderManagerV2.getInstance();
    const encoder = Render.getInstance().getCommandEncoder();
    const width = this.texture!.width;
    const height = this.texture!.height;

    rm.performCulling(camera, RenderCategory.SHADOWS);
    rm.setCamera(camera);
    if (staticDirty) {
      this.pass(
        this.views[layer]!,
        'clear',
        'static',
        `${this.label} static ${layer}`,
        timestampLabel,
        width,
        height,
      );
    }
    encoder.copyTextureToTexture(
      { texture: this.texture!, origin: { x: 0, y: 0, z: layer } },
      { texture: this.live!, origin: { x: 0, y: 0, z: layer } },
      { width, height, depthOrArrayLayers: 1 },
    );
    if (movables) {
      this.pass(
        liveView,
        'load',
        'movable',
        `${this.label} movable ${layer}`,
        timestampLabel,
        width,
        height,
      );
    }
    this.liveDirty[layer] = movables;
  }

  private pass(
    view: GPUTextureView,
    loadOp: GPULoadOp,
    filter: 'static' | 'movable',
    label: string,
    timestampLabel: string,
    width: number,
    height: number,
  ): void {
    const rm = RenderManagerV2.getInstance();
    const desc = GPUUtils.createRenderPassDescriptor(
      label,
      [],
      GPUUtils.createDepthStencilAttachment(view, loadOp),
    );
    const ts = GPUProfiler.getInstance().getTimestampWrites(timestampLabel);
    if (ts) desc.timestampWrites = ts;
    const pass = Render.getInstance().getCommandEncoder().beginRenderPass(desc);
    GPUUtils.configureViewportAndScissor(pass, width, height);
    rm.shadowCasterFilter = filter;
    rm.render(RenderCategory.SHADOWS, pass);
    rm.shadowCasterFilter = 'all';
    pass.end();
  }

  private createCache(live: GPUTexture): void {
    this.texture?.destroy();
    this.live = live;
    this.texture = GPUUtils.getDevice().createTexture({
      label: `${this.label}_static_cache`,
      size: { width: live.width, height: live.height, depthOrArrayLayers: live.depthOrArrayLayers },
      format: live.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.views = [];
    for (let layer = 0; layer < live.depthOrArrayLayers; layer++) {
      this.views.push(
        this.texture.createView({
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
      );
    }
    this.liveDirty = new Array(live.depthOrArrayLayers).fill(true);
  }

  public destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.views = [];
    this.live = null;
  }
}
