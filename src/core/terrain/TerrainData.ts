// ---------------------------------------------------------------------------
// TerrainData — shared heightmap + dirty-chunk tracking
// ---------------------------------------------------------------------------

export interface TerrainConfig {
  /** Total world-space width (X axis). */
  totalWidth: number;
  /** Total world-space depth (Z axis). */
  totalDepth: number;
  /** Peak elevation above the terrain entity's Y position. */
  maxHeight: number;
  /** World-space size of each chunk (same for X and Z). */
  chunkSize: number;
  /** Number of chunks along X. */
  chunkCountX: number;
  /** Number of chunks along Z. */
  chunkCountZ: number;
  /** Heightmap texture width in pixels. */
  heightmapWidth: number;
  /** Heightmap texture depth in pixels. */
  heightmapDepth: number;
  /** Vertices per chunk side at LOD 0 (including both edge vertices). */
  vertsPerSide: number;
}

export class TerrainData {
  public readonly config: TerrainConfig;
  /** Flat Float32Array [0,1] row-major (Z-major). Index = z * width + x. */
  public readonly heightmap: Float32Array;

  private readonly dirtyChunks = new Set<number>();

  constructor(config: TerrainConfig, heightmap: Float32Array) {
    this.config = config;
    this.heightmap = heightmap;
  }

  // ---------------------------------------------------------------------------
  // Height sampling
  // ---------------------------------------------------------------------------

  /** Direct pixel access, clamped to valid range. */
  public getHeightPixel(px: number, pz: number): number {
    const { heightmapWidth, heightmapDepth } = this.config;
    const x = Math.max(0, Math.min(heightmapWidth - 1, Math.round(px)));
    const z = Math.max(0, Math.min(heightmapDepth - 1, Math.round(pz)));
    return this.heightmap[z * heightmapWidth + x] ?? 0;
  }

  /**
   * Bilinear height sample from normalised world coordinates [0,1].
   * Returns raw [0,1] value — multiply by maxHeight for world-space Y.
   */
  public getHeightBilinear(normalizedX: number, normalizedZ: number): number {
    const { heightmapWidth, heightmapDepth } = this.config;
    const px = normalizedX * (heightmapWidth - 1);
    const pz = normalizedZ * (heightmapDepth - 1);

    const x0 = Math.max(0, Math.min(heightmapWidth - 1, Math.floor(px)));
    const z0 = Math.max(0, Math.min(heightmapDepth - 1, Math.floor(pz)));
    const x1 = Math.min(heightmapWidth - 1, x0 + 1);
    const z1 = Math.min(heightmapDepth - 1, z0 + 1);

    const fx = px - x0;
    const fz = pz - z0;

    const h00 = this.heightmap[z0 * heightmapWidth + x0] ?? 0;
    const h10 = this.heightmap[z0 * heightmapWidth + x1] ?? 0;
    const h01 = this.heightmap[z1 * heightmapWidth + x0] ?? 0;
    const h11 = this.heightmap[z1 * heightmapWidth + x1] ?? 0;

    return h00 + (h10 - h00) * fx + (h01 - h00) * fz + (h00 - h10 - h01 + h11) * fx * fz;
  }

  /**
   * World-space height at (worldX, worldZ), taking the terrain config into account.
   * Returns Y offset in world units (add terrain entity's world Y to get absolute Y).
   */
  public getWorldHeight(worldX: number, worldZ: number): number {
    const nx = worldX / this.config.totalWidth;
    const nz = worldZ / this.config.totalDepth;
    return this.getHeightBilinear(nx, nz) * this.config.maxHeight;
  }

  // ---------------------------------------------------------------------------
  // Dirty-chunk tracking (used by deformation / editor in future phases)
  // ---------------------------------------------------------------------------

  private chunkKey(cx: number, cz: number): number {
    return cx * this.config.chunkCountZ + cz;
  }

  public markChunkDirty(cx: number, cz: number): void {
    this.dirtyChunks.add(this.chunkKey(cx, cz));
  }

  public isDirty(cx: number, cz: number): boolean {
    return this.dirtyChunks.has(this.chunkKey(cx, cz));
  }

  public clearDirty(cx: number, cz: number): void {
    this.dirtyChunks.delete(this.chunkKey(cx, cz));
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /** Renders heightmap to Canvas2D and returns a PNG Blob (for editor export). */
  public exportHeightmapPNG(): Promise<Blob> {
    const { heightmapWidth, heightmapDepth } = this.config;
    const canvas = document.createElement('canvas');
    canvas.width = heightmapWidth;
    canvas.height = heightmapDepth;

    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('Canvas 2D context unavailable'));

    const imageData = ctx.createImageData(heightmapWidth, heightmapDepth);
    for (let i = 0; i < heightmapWidth * heightmapDepth; i++) {
      const v = Math.round((this.heightmap[i] ?? 0) * 255);
      imageData.data[i * 4] = v;
      imageData.data[i * 4 + 1] = v;
      imageData.data[i * 4 + 2] = v;
      imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
        'image/png',
      );
    });
  }
}
