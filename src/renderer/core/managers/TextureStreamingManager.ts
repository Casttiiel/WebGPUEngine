import { vec3 } from 'gl-matrix';
import { Texture } from '../../resources/Texture';

/** World-space distance threshold (metres) within which full-resolution mips are streamed in. */
const FULL_RES_DIST_SQ = 30 * 30;

/** Maximum number of concurrent async streaming uploads per update tick. */
const MAX_CONCURRENT = 2;

interface StreamEntry {
  texture: Texture;
  getPos: () => vec3;
}

/**
 * TextureStreamingManager — singleton that manages progressive texture resolution streaming.
 *
 * On initial load, large textures are uploaded at a reduced resolution (coarsest mips only)
 * to minimise VRAM cost.  Each frame this manager evaluates the camera–object distance for
 * every registered texture and triggers a non-blocking full-resolution upload for textures
 * that are within FULL_RES_DIST_SQ.
 *
 * Usage:
 *   TextureStreamingManager.getInstance().register(texture, () => entity.getWorldPos());
 *   // called once per frame from ModuleRender:
 *   TextureStreamingManager.getInstance().update(camera.getPosition());
 */
export class TextureStreamingManager {
  private static _instance: TextureStreamingManager | null = null;

  /** texture → list of world-position getters (one per entity that uses the texture) */
  private readonly registry = new Map<Texture, StreamEntry[]>();

  /** Textures that passed the distance test this frame and are waiting to be upgraded */
  private readonly queue: Texture[] = [];

  /** Number of streaming uploads currently in flight */
  private inFlight = 0;

  private constructor() {}

  public static getInstance(): TextureStreamingManager {
    if (!TextureStreamingManager._instance) {
      TextureStreamingManager._instance = new TextureStreamingManager();
    }
    return TextureStreamingManager._instance;
  }

  /**
   * Register a streamable texture with the world-position getter of an entity that uses it.
   * Safe to call multiple times for the same texture (e.g., several meshes sharing one material).
   */
  public register(texture: Texture, getPos: () => vec3): void {
    if (!texture.isStreamable()) return;
    let entries = this.registry.get(texture);
    if (!entries) {
      entries = [];
      this.registry.set(texture, entries);
    }
    // Avoid duplicates (reference equality on the getter fn is sufficient since callers
    // store the lambda on the component instance).
    if (!entries.some((e) => e.getPos === getPos)) {
      entries.push({ texture, getPos });
    }
  }

  /**
   * Remove all registrations for a specific (texture, position-getter) pair.
   * Called when a RenderComponent is disposed.
   */
  public unregister(texture: Texture, getPos: () => vec3): void {
    const entries = this.registry.get(texture);
    if (!entries) return;
    const next = entries.filter((e) => e.getPos !== getPos);
    if (next.length === 0) {
      this.registry.delete(texture);
    } else {
      this.registry.set(texture, next);
    }
  }

  /**
   * Called once per frame by ModuleRender after the camera position is known.
   * Evaluates camera–object distances and enqueues textures that need a full-res upgrade.
   * Capped to MAX_CONCURRENT concurrent uploads so the GPU queue is never flooded.
   */
  public update(cameraPos: vec3): void {
    // Destroy GPU textures superseded by streaming upgrades in the previous frame(s).
    // This runs before any command-buffer recording for the current frame, so all previous
    // submits that could reference the old textures have already occurred.
    Texture.flushPendingDestroys();

    const toDelete: Texture[] = [];

    for (const [texture, entries] of this.registry) {
      // Lazily prune textures that are already fully loaded.
      if (!texture.isStreamable()) {
        toDelete.push(texture);
        continue;
      }

      // Find the closest entity that uses this texture.
      let minDistSq = Infinity;
      for (const entry of entries) {
        const wp = entry.getPos();
        const dx = wp[0] - cameraPos[0];
        const dy = wp[1] - cameraPos[1];
        const dz = wp[2] - cameraPos[2];
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < minDistSq) minDistSq = dSq;
      }

      if (minDistSq <= FULL_RES_DIST_SQ && !this.queue.includes(texture)) {
        this.queue.push(texture);
      }
    }

    for (const t of toDelete) {
      this.registry.delete(t);
    }

    this.flushQueue();
  }

  private flushQueue(): void {
    while (this.inFlight < MAX_CONCURRENT && this.queue.length > 0) {
      const texture = this.queue.shift()!;
      if (!texture.isStreamable()) continue;
      this.inFlight++;
      console.log(
        `[TextureStreaming] ▶ uploading: ${texture.getName()} (in-flight: ${this.inFlight})`,
      );
      texture
        .streamFullResolution()
        .then(() => {
          console.log(`[TextureStreaming] ✔ done: ${texture.getName()}`);
        })
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          // Process more pending textures now that a slot is free.
          this.flushQueue();
        });
    }
  }

  /** Remove all registrations (e.g., on scene unload). */
  public clear(): void {
    this.registry.clear();
    this.queue.length = 0;
    this.inFlight = 0;
  }
}
