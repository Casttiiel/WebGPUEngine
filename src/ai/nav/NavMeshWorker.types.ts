/** Input sent from the main thread to the NavMesh worker. */
export interface NavMeshWorkerInput {
  positions: Float32Array;
  indices: Uint32Array;
  /** Override individual Recast config values (e.g. cs/ch for large terrains). */
  recastOverrides?: {
    cs?: number;
    ch?: number;
  };
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
