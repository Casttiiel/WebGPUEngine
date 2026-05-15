import { vec3, mat4 } from 'gl-matrix';
import { init, NavMesh as RecastNavMesh, NavMeshQuery } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';

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
    await ensureInit();

    // Apply world matrix to positions if needed
    let finalPositions: Float32Array;
    if (worldMatrix) {
      finalPositions = new Float32Array(positions.length);
      for (let i = 0; i < positions.length / 3; i++) {
        const v = vec3.fromValues(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
        vec3.transformMat4(v, v, worldMatrix);
        finalPositions[i * 3] = v[0];
        finalPositions[i * 3 + 1] = v[1];
        finalPositions[i * 3 + 2] = v[2];
      }
    } else {
      finalPositions = positions;
    }

    // Build centroid list for ProbeAutoPlacement
    this._centroids = [];
    const triCount = Math.floor(indices.length / 3);
    for (let i = 0; i < triCount; i++) {
      const i0 = indices[i * 3]!;
      const i1 = indices[i * 3 + 1]!;
      const i2 = indices[i * 3 + 2]!;
      this._centroids.push(
        vec3.fromValues(
          (finalPositions[i0 * 3]! + finalPositions[i1 * 3]! + finalPositions[i2 * 3]!) / 3,
          (finalPositions[i0 * 3 + 1]! +
            finalPositions[i1 * 3 + 1]! +
            finalPositions[i2 * 3 + 1]!) /
            3,
          (finalPositions[i0 * 3 + 2]! +
            finalPositions[i1 * 3 + 2]! +
            finalPositions[i2 * 3 + 2]!) /
            3,
        ),
      );
    }

    // Destroy previous navmesh if any
    this._navMesh?.destroy();
    this._navMesh = null;
    this._query = null;
    this._built = false;

    // Generate Detour navmesh using Recast voxelisation pipeline.
    // cs=0.3m gives good path accuracy for human-scale scenes at a fraction of
    // the voxel count vs cs=0.1 (a 256×256 terrain goes from ~6.5M to ~728K cells).
    const { success, navMesh } = generateSoloNavMesh(
      Array.from(finalPositions),
      Array.from(indices),
      {
        cs: 0.3,
        ch: 0.1,
        walkableSlopeAngle: 45,
        walkableHeight: 20, // voxels = 2.0 m / 0.1 ch
        walkableClimb: 3, // voxels = 0.3 m / 0.1 ch
        walkableRadius: 0, // no erosion — Rapier physics handles wall avoidance
        maxEdgeLen: 120, // voxels
        maxSimplificationError: 1.3,
        minRegionArea: 2, // was 8 — tiny island regions now kept (avoids discarding thin areas)
        mergeRegionArea: 20,
        maxVertsPerPoly: 6,
        detailSampleDist: 6,
        detailSampleMaxError: 1,
      },
    );

    if (!success || !navMesh) {
      console.error(
        '[NavMesh] Recast generateSoloNavMesh failed — falling back to no pathfinding.',
      );
      return;
    }

    this._navMesh = navMesh;
    this._query = new NavMeshQuery(navMesh);
    this._built = true;
    console.log(`[NavMesh] Built (Recast/Detour) — ${triCount} source triangles`);
  }

  public dispose(): void {
    this._navMesh?.destroy();
    this._navMesh = null;
    this._query = null;
    this._centroids = [];
    this._built = false;
  }
}
