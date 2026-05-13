// ---------------------------------------------------------------------------
// TerrainNormalMapGenerator — Phase 4
// Computes a per-chunk tangent-space normal map from the high-resolution
// heightmap.  The result is independent of the mesh LOD level and gives
// finer shading detail than vertex normals alone.
//
// Tangent frame (matches mikktspace convention for Y-up terrain with
// U along +X and V along +Z):
//   T = (1, 0, 0)     — along +X (increasing U)
//   B = (0, 0, -1)    — cross(N, T) with handedness +1
//   N = (0, 1, 0)     — base normal (flat surface)
//
// Encoding: standard RGB8 — (channel * 0.5 + 0.5) × 255
//   flat surface → (128, 128, 255)
// ---------------------------------------------------------------------------

import { TerrainData } from './TerrainData';

export class TerrainNormalMapGenerator {
  /**
   * Generates a tangent-space normal map for one terrain chunk.
   *
   * @param terrainData - Shared heightmap + config.
   * @param chunkX      - Chunk column index (0-based).
   * @param chunkZ      - Chunk row index (0-based).
   * @param resolution  - Output size in pixels per side (default 256).
   * @returns RGBA8 Uint8Array, row-major (Z-major), `resolution² × 4` bytes.
   */
  public static generate(
    terrainData: TerrainData,
    chunkX: number,
    chunkZ: number,
    resolution: number = 256,
  ): Uint8Array {
    const { config } = terrainData;
    const { chunkSize, totalWidth, totalDepth, maxHeight } = config;

    const out = new Uint8Array(resolution * resolution * 4);

    // World-space step between adjacent texels (used for central-difference derivative).
    // One extra step past the chunk edges samples neighbour heightmap data — this is
    // intentional and prevents visible seams at chunk boundaries.
    const worldStep = chunkSize / resolution;
    const invDenom = 1.0 / (2.0 * worldStep); // pre-multiplied denominator

    for (let py = 0; py < resolution; py++) {
      for (let px = 0; px < resolution; px++) {
        // UV within chunk [0, 1]
        const u = (px + 0.5) / resolution;
        const v = (py + 0.5) / resolution;

        // Absolute world position of this texel
        const wx = chunkX * chunkSize + u * chunkSize;
        const wz = chunkZ * chunkSize + v * chunkSize;

        // Normalised terrain coordinates [0, 1] for central-difference neighbours
        const nxL = (wx - worldStep) / totalWidth;
        const nxR = (wx + worldStep) / totalWidth;
        const nzD = (wz - worldStep) / totalDepth; // -Z
        const nzU = (wz + worldStep) / totalDepth; // +Z
        const nxC = wx / totalWidth;
        const nzC = wz / totalDepth;

        const hL = terrainData.getHeightBilinear(nxL, nzC) * maxHeight;
        const hR = terrainData.getHeightBilinear(nxR, nzC) * maxHeight;
        const hD = terrainData.getHeightBilinear(nxC, nzD) * maxHeight;
        const hU = terrainData.getHeightBilinear(nxC, nzU) * maxHeight;

        // Heightmap surface derivatives
        const dhdx = (hR - hL) * invDenom; // ∂h/∂x
        const dhdz = (hU - hD) * invDenom; // ∂h/∂z

        // World-space surface normal N_world = normalize(-∂h/∂x, 1, -∂h/∂z)
        // (same formula as TerrainMeshBuilder vertex normals)
        const nLen = Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1.0);

        // Project to tangent space:
        //   N_ts.x = dot(N_world, T=(1,0,0))   = N_world.x =  -dhdx / nLen
        //   N_ts.y = dot(N_world, B=(0,0,-1))  = -N_world.z =  dhdz / nLen
        //   N_ts.z = dot(N_world, N=(0,1,0))   =  N_world.y =   1   / nLen
        const nts_x = -dhdx / nLen;
        const nts_y = dhdz / nLen;
        const nts_z = 1.0 / nLen;

        // Encode into RGBA8: channel = clamp(round((v * 0.5 + 0.5) * 255), 0, 255)
        const idx = (py * resolution + px) * 4;
        out[idx] = Math.max(0, Math.min(255, Math.round((nts_x * 0.5 + 0.5) * 255)));
        out[idx + 1] = Math.max(0, Math.min(255, Math.round((nts_y * 0.5 + 0.5) * 255)));
        out[idx + 2] = Math.max(0, Math.min(255, Math.round((nts_z * 0.5 + 0.5) * 255)));
        out[idx + 3] = 255;
      }
    }

    return out;
  }
}
