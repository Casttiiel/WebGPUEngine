import { vec3, mat4 } from 'gl-matrix';
import { init, NavMesh as RecastNavMesh, NavMeshQuery, importNavMesh } from 'recast-navigation';
import NavMeshWorkerClass from './NavMeshWorker?worker';
import type { NavMeshWorkerInput, NavMeshWorkerOutput } from './NavMeshWorker.types';

/** Cached init promise — resolves immediately if already initialised. */
let _initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

/**
 * NavMesh — singleton wrapping Recast/Detour for AI pathfinding.
 *
 * Built once from GLTFLoader when a node with extras.type === "navmesh" is found.
 * Query anywhere via NavMesh.getInstance().
 *
 * Public API is intentionally kept identical to the old triangle-graph version so
 * that callers (RequestPathAction, ProbeAutoPlacement, NavMeshBuilder) need no changes.
 */
export class NavMesh {
  private static _instance: NavMesh | null = null;

  private _built = false;
  /** Raw triangles kept for getCentroids() (used by ProbeAutoPlacement). */
  private _centroids: vec3[] = [];
  /** The Detour navmesh object produced by generateSoloNavMesh. */
  private _navMesh: RecastNavMesh | null = null;
  /** Query interface wrapping _navMesh. */
  private _query: NavMeshQuery | null = null;

  private constructor() {}

  public static getInstance(): NavMesh {
    if (!NavMesh._instance) NavMesh._instance = new NavMesh();
    return NavMesh._instance;
  }

  public static preloadWasm(): void {
    // Start WASM init early (during loading phase) so ensureInit() is already
    // resolved by the time buildNavMesh() is called during gameplay.
    ensureInit().catch((e) => console.error('[NavMesh] WASM preload failed:', e));
  }

  public isBuilt(): boolean {
    return this._built;
  }

  /** Returns the internal NavMeshQuery for direct Detour queries (used by AStar). */
  public getQuery(): NavMeshQuery | null {
    return this._query;
  }

  /** Returns a copy of every triangle centroid. Used by ProbeAutoPlacement. */
  public getCentroids(): vec3[] {
    return this._centroids.map((c) => vec3.clone(c));
  }

  /**
   * Builds the navmesh from raw GLTF geometry using Recast/Detour.
   * Async because it initialises the WASM module on first call.
   *
   * @param positions  Flat Float32 vertex positions [x0,y0,z0, x1,y1,z1, …]
   * @param indices    Triangle index buffer
   * @param worldMatrix  Optional node-to-world transform applied to every vertex
   */
  public async build(
    positions: Float32Array,
    indices: Uint32Array | Uint16Array,
    worldMatrix?: mat4,
  ): Promise<void> {
    const t0 = performance.now();
    // Ensure the WASM module is ready on the main thread — needed for importNavMesh().
    await ensureInit();
    console.log(`[NavMesh] ensureInit: ${(performance.now() - t0).toFixed(1)}ms`);

    // Apply world matrix to positions if provided (fast O(n) loop on main thread).
    let finalPositions: Float32Array;
    if (worldMatrix) {
      finalPositions = new Float32Array(positions.length);
      for (let i = 0; i < positions.length / 3; i++) {
        const v = vec3.fromValues(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
        vec3.transformMat4(v, v, worldMatrix);
        finalPositions[i * 3]     = v[0];
        finalPositions[i * 3 + 1] = v[1];
        finalPositions[i * 3 + 2] = v[2];
      }
    } else {
      // Copy so the transfer to the worker does not detach the caller's buffer.
      finalPositions = new Float32Array(positions);
    }

    // Normalise to Uint32Array so the worker always receives the same type.
    const finalIndices =
      indices instanceof Uint32Array ? indices : new Uint32Array(indices);

    // Tear down any previously built navmesh before replacing it.
    this._navMesh?.destroy();
    this._navMesh = null;
    this._query = null;
    this._built = false;

    // Offload the heavy Recast voxelisation to a worker thread so it does not
    // freeze the renderer.  transferring the ArrayBuffers avoids a memory copy.
    const tWorker = performance.now();
    const result = await this.buildInWorker(finalPositions, finalIndices);
    console.log(`[NavMesh] worker: ${(performance.now() - tWorker).toFixed(1)}ms`);

    if (!result.navmeshBytes) {
      console.error('[NavMesh] Worker reported failure — falling back to no pathfinding.');
      return;
    }

    // Reconstruct centroid list for ProbeAutoPlacement.
    this._centroids = [];
    const { centroids, triCount } = result;
    for (let i = 0; i < triCount; i++) {
      this._centroids.push(
        vec3.fromValues(centroids[i * 3]!, centroids[i * 3 + 1]!, centroids[i * 3 + 2]!),
      );
    }

    // importNavMesh re-creates the Detour navmesh on the main thread from the
    // binary blob produced by the worker.  This call is fast (no voxelisation).
    const tImport = performance.now();
    this._navMesh = importNavMesh(result.navmeshBytes) as RecastNavMesh;
    this._query = new NavMeshQuery(this._navMesh);
    console.log(`[NavMesh] importNavMesh+Query: ${(performance.now() - tImport).toFixed(1)}ms`);
    this._built = true;
    console.log(`[NavMesh] Built (Recast/Detour) — ${triCount} source triangles, total: ${(performance.now() - t0).toFixed(1)}ms`);
  }

  /**
   * Spawns a short-lived Web Worker to run Recast voxelisation off the main thread.
   * Transfers the input ArrayBuffers to avoid copying; they are detached in the caller
   * after this call returns so must not be used afterwards.
   */
  private buildInWorker(
    positions: Float32Array,
    indices: Uint32Array,
  ): Promise<Extract<NavMeshWorkerOutput, { error?: undefined }>> {
    return new Promise((resolve, reject) => {
      const worker = new NavMeshWorkerClass();

      worker.onmessage = (e: MessageEvent<NavMeshWorkerOutput>) => {
        worker.terminate();
        if (e.data.error) {
          reject(new Error(`[NavMesh worker] ${e.data.error}`));
        } else {
          resolve(e.data as Extract<NavMeshWorkerOutput, { error?: undefined }>);
        }
      };

      worker.onerror = (e: ErrorEvent) => {
        worker.terminate();
        reject(new Error(`[NavMesh worker] ${e.message}`));
      };

      const msg: NavMeshWorkerInput = { positions, indices };
      worker.postMessage(msg, [positions.buffer, indices.buffer]);
    });
  }

  public dispose(): void {
    this._navMesh?.destroy();
    this._navMesh = null;
    this._query = null;
    this._centroids = [];
    this._built = false;
  }
}
