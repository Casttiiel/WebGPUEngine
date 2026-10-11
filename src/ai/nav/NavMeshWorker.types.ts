/**
 * Override individual Recast config values (e.g. cs/ch for large terrains, agent size
 * for tactical scenes). walkable* values are in voxels (cs horizontally, ch vertically).
 */
export interface RecastOverrides {
  cs?: number;
  ch?: number;
  walkableSlopeAngle?: number;
  walkableHeight?: number;
  walkableClimb?: number;
  walkableRadius?: number;
}

/** Input sent from the main thread to the NavMesh worker. */
export interface NavMeshWorkerInput {
  positions: Float32Array;
  indices: Uint32Array;
  recastOverrides?: RecastOverrides;
}

/** Successful result from the NavMesh worker. */
export interface NavMeshWorkerSuccess {
  navmeshBytes: Uint8Array;
  /** Flat [x0,y0,z0, x1,y1,z1, …] centroid data. Length = triCount * 3. */
  centroids: Float32Array;
  triCount: number;
  error?: undefined;
}

/** Error result from the NavMesh worker. */
export interface NavMeshWorkerError {
  error: string;
}

export type NavMeshWorkerOutput = NavMeshWorkerSuccess | NavMeshWorkerError;
