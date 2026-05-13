// ---------------------------------------------------------------------------
// TerrainSplatGenerator — generates a per-chunk RGBA8 splat weight texture
// ---------------------------------------------------------------------------
// Channels: R = layer0 (ground/grass), G = layer1 (rock), B = layer2 (snow)
//           A = reserved (set to 0)
// Weights are computed from heightmap height + slope and normalised to sum 1.
// ---------------------------------------------------------------------------

import { TerrainData } from './TerrainData';

export class TerrainSplatGenerator {
  /**
   * Generates a splat weight texture for the specified chunk.
   *
   * @param terrainData  Shared heightmap / config.
   * @param chunkX       Chunk column index (0-based).
   * @param chunkZ       Chunk row index (0-based).
   * @param resolution   Output texture side length in pixels (default 256).
   * @returns RGBA8 Uint8Array of length `resolution * resolution * 4`.
   */
  public static generate(
    terrainData: TerrainData,
    chunkX: number,
    chunkZ: number,
    resolution = 256,
  ): Uint8Array {
    const { config } = terrainData;
    const { chunkSize } = config;

    // World-space origin of this chunk
    const originX = chunkX * chunkSize;
    const originZ = chunkZ * chunkSize;

    // Step size in world units between adjacent texture pixels
    const step = chunkSize / (resolution - 1);
    // Step normalised to [0,1] heightmap space for central differences
    const totalW = config.totalWidth;
    const totalD = config.totalDepth;

    const pixels = new Uint8Array(resolution * resolution * 4);
    let idx = 0;

    for (let pz = 0; pz < resolution; pz++) {
      for (let px = 0; px < resolution; px++) {
        // World position of this sample
        const wx = originX + px * step;
        const wz = originZ + pz * step;

        // Normalised heightmap coordinates [0,1]
        const nx = wx / totalW;
        const nz = wz / totalD;

        // Height [0,1]
        const h = terrainData.getHeightBilinear(nx, nz);

        // Neighbours for slope estimation (central difference)
        const nxL = (wx - step) / totalW;
        const nxR = (wx + step) / totalW;
        const nzU = (wz - step) / totalD;
        const nzD = (wz + step) / totalD;

        const hL = terrainData.getHeightBilinear(nxL, nz);
        const hR = terrainData.getHeightBilinear(nxR, nz);
        const hU = terrainData.getHeightBilinear(nx, nzD); // +Z direction
        const hD = terrainData.getHeightBilinear(nx, nzU);

        // World-space gradient (scaled by maxHeight)
        const maxH = config.maxHeight;
        const dhdx = ((hR - hL) * maxH) / (2 * step);
        const dhdz = ((hU - hD) * maxH) / (2 * step);

        // World-space normal (not normalised yet)
        // N = normalize(-dhdx, 1, -dhdz), N.y = 1 / sqrt(dhdx²+dhdz²+1)
        const nLen = Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1.0);
        const slope = 1.0 - 1.0 / nLen; // 0 = flat, approaches 1 for vertical

        // ── Layer weights ────────────────────────────────────────────────────
        const snowW = TerrainSplatGenerator.smoothstep(0.55, 0.8, h);
        // Rock on steep slopes, dampened at high elevation (snow covers rock)
        const rockW = TerrainSplatGenerator.smoothstep(0.25, 0.6, slope) * (1.0 - snowW * 0.7);
        // Ground fills the remainder
        const grassW = Math.max(0.0, 1.0 - snowW - rockW);

        // Normalise so weights always sum to 1
        const total = grassW + rockW + snowW;
        const inv = 1.0 / Math.max(total, 0.001);

        pixels[idx + 0] = Math.min(255, Math.round(grassW * inv * 255)); // R = grass/ground
        pixels[idx + 1] = Math.min(255, Math.round(rockW * inv * 255)); //  G = rock
        pixels[idx + 2] = Math.min(255, Math.round(snowW * inv * 255)); //  B = snow
        pixels[idx + 3] = 0; // A = reserved

        idx += 4;
      }
    }

    return pixels;
  }

  private static smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3.0 - 2.0 * t);
  }
}
