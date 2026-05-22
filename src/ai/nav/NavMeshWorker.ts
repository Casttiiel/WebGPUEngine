/// <reference lib="webworker" />
import { init, exportNavMesh } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import type {
  NavMeshWorkerInput,
  NavMeshWorkerOutput,
  NavMeshWorkerSuccess,
  NavMeshWorkerError,
} from './NavMeshWorker.types';

/**
 * Recast config — mirrors NavMesh.build() parameters.
 * Kept here so the worker is self-contained; update both places if tuning is needed.
 */
const RECAST_CONFIG = {
  cs: 0.3,
  ch: 0.1,
  walkableSlopeAngle: 45,
  walkableHeight: 20, // voxels = 2.0 m / 0.1 ch
  walkableClimb: 3, // voxels = 0.3 m / 0.1 ch
  walkableRadius: 0, // no erosion — Rapier physics handles wall avoidance
  maxEdgeLen: 120,
  maxSimplificationError: 1.3,
  minRegionArea: 2,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

self.onmessage = async (e: MessageEvent<NavMeshWorkerInput>): Promise<void> => {
  const { positions, indices } = e.data;

  try {
    // Initialise Recast/Detour WASM inside the worker.
    await init();

    const triCount = Math.floor(indices.length / 3);

    // Build centroid array (needed by main thread for ProbeAutoPlacement).
    const centroids = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      const i0 = indices[i * 3]!;
      const i1 = indices[i * 3 + 1]!;
      const i2 = indices[i * 3 + 2]!;
      centroids[i * 3] = (positions[i0 * 3]! + positions[i1 * 3]! + positions[i2 * 3]!) / 3;
      centroids[i * 3 + 1] =
        (positions[i0 * 3 + 1]! + positions[i1 * 3 + 1]! + positions[i2 * 3 + 1]!) / 3;
      centroids[i * 3 + 2] =
        (positions[i0 * 3 + 2]! + positions[i1 * 3 + 2]! + positions[i2 * 3 + 2]!) / 3;
    }

    // Heavy Recast voxelisation — runs in the worker so the main thread stays free.
    // TypedArrays implement ArrayLike<number> so no Array.from() conversion needed.
    const tRecast = performance.now();
    const { success, navMesh } = generateSoloNavMesh(positions, indices, RECAST_CONFIG);
    console.log(
      `[NavMeshWorker] generateSoloNavMesh: ${(performance.now() - tRecast).toFixed(1)}ms`,
    );

    if (!success || !navMesh) {
      const out: NavMeshWorkerError = { error: 'Recast generateSoloNavMesh returned failure' };
      postMessage(out);
      return;
    }

    // Serialise the Detour navmesh to a binary blob and transfer ownership of
    // the underlying ArrayBuffer so no copy is made across the thread boundary.
    const navmeshBytes = exportNavMesh(navMesh);
    navMesh.destroy(); // free WASM heap inside the worker

    const out: NavMeshWorkerSuccess = { navmeshBytes, centroids, triCount };
    postMessage(out, [navmeshBytes.buffer, centroids.buffer]);
  } catch (err) {
    const out: NavMeshWorkerError = { error: String(err) };
    postMessage(out);
  }
};
