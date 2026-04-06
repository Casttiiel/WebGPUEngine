/**
 * Central registry mapping engine-internal texture names to their current GPUTextureView.
 *
 * GPU systems (DeferredRenderer, AmbientLight, SSR, …) register their output textures
 * here after creating or resizing render targets. Materials that reference "@engine:xxx"
 * slots subscribe to be notified when views change (e.g. after a resize) so they can
 * rebuild their bind groups automatically.
 */

/** Well-known canonical names for engine textures. */
export const ENGINE_TEXTURES = {
  LINEAR_DEPTH: 'engine:linear_depth',
  ENV_CUBEMAP: 'engine:env_cubemap',
  SSR_RESULT: 'engine:ssr_result',
  GLASS_REFRACTION: 'engine:glass_refraction',
  ACC_LIGHT: 'engine:acc_light',
  GBUFFER_ALBEDO: 'engine:gbuffer_albedo',
  GBUFFER_NORMALS: 'engine:gbuffer_normals',
} as const;

class EngineTextureRegistryImpl {
  private readonly textures = new Map<string, GPUTextureView>();
  private readonly subscribers = new Map<string, Set<() => void>>();

  /**
   * Register or update a named engine texture.
   * Notifies all current subscribers synchronously.
   */
  public register(name: string, view: GPUTextureView): void {
    this.textures.set(name, view);
    const callbacks = this.subscribers.get(name);
    if (callbacks) {
      for (const cb of callbacks) cb();
    }
  }

  /** Returns the current view for a named engine texture, or null if not yet registered. */
  public get(name: string): GPUTextureView | null {
    return this.textures.get(name) ?? null;
  }

  /**
   * Subscribe to changes for a named engine texture.
   *
   * - If the texture is already registered, the callback fires immediately.
   * - It fires again whenever the texture is re-registered (e.g. after a resize).
   *
   * Returns an unsubscribe function — call it in dispose() / release() to avoid leaks.
   */
  public subscribe(name: string, cb: () => void): () => void {
    if (!this.subscribers.has(name)) {
      this.subscribers.set(name, new Set());
    }
    this.subscribers.get(name)!.add(cb);
    // Fire immediately if the texture is already available.
    if (this.textures.has(name)) cb();
    return () => this.subscribers.get(name)?.delete(cb);
  }

  /** Clear all registered textures and subscriptions. Call during engine restart. */
  public clear(): void {
    this.textures.clear();
    this.subscribers.clear();
  }
}

export const EngineTextureRegistry = new EngineTextureRegistryImpl();
