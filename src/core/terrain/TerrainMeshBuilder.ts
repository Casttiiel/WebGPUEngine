// ---------------------------------------------------------------------------
// TerrainMeshBuilder — CPU-side chunk mesh generation (LOD aware)
// ---------------------------------------------------------------------------
// Produces flat Float32Arrays compatible with Mesh.setData() internal format.
// The returned object shape matches RenderComponentMeshDataType.meshData.
//
// Winding: v00→v01→v10 / v10→v01→v11
//   Normal via cross(T_z, T_x) = (+, +Y, +) for flat terrain → correct Y-up normals.
//   The terrain_test.tech uses double_sided rendering, so winding does not affect
//   visibility during the prototype phase.
// ---------------------------------------------------------------------------

import { TerrainData } from './TerrainData';

export interface TerrainMeshBuildParams {
  terrainData: TerrainData;
  chunkX: number;
  chunkZ: number;
  /** 0 = full resolution, 1 = half, 2 = quarter, 3 = eighth. */
  lodLevel: number;
  /**
   * How far (world units) the skirt vertices hang below the border edge.
   * Set to 0 to disable skirts. Default: 4.
   */
  skirtDepth?: number;
}

export interface RawMeshData {
  attributes: {
    POSITION: Float32Array;
    NORMAL: Float32Array;
    TEXCOORD_0: Float32Array;
    TANGENT: undefined;
  };
  indices: Uint32Array;
}

export class TerrainMeshBuilder {
  /**
   * Builds a chunk mesh at the requested LOD level.
   * All vertex positions are in the chunk's LOCAL space:
   *   X ∈ [0, chunkSize], Y = world height, Z ∈ [0, chunkSize].
   * The chunk entity's TransformComponent positions it in world space.
   */
  static build(params: TerrainMeshBuildParams): RawMeshData {
    const { terrainData, chunkX, chunkZ, lodLevel } = params;
    const skirtDepth = params.skirtDepth ?? 4;
    const cfg = terrainData.config;

    // LOD reduces vertex count: step = 2^lodLevel
    const step = 1 << Math.max(0, Math.min(lodLevel, 3));
    const baseVerts = cfg.vertsPerSide;
    // Vertices per side at this LOD (minimum 2)
    const vertsX = Math.max(2, Math.ceil((baseVerts - 1) / step) + 1);
    const vertsZ = vertsX;

    const totalVerts = vertsX * vertsZ;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);

    // World-space start of this chunk
    const chunkWorldX = chunkX * cfg.chunkSize;
    const chunkWorldZ = chunkZ * cfg.chunkSize;

    /** Returns world-space height (relative to terrain entity Y) at (wx, wz). */
    const getH = (wx: number, wz: number): number => {
      const nx = Math.max(0, Math.min(1, wx / cfg.totalWidth));
      const nz = Math.max(0, Math.min(1, wz / cfg.totalDepth));
      return terrainData.getHeightBilinear(nx, nz) * cfg.maxHeight;
    };

    // World-space step between adjacent vertices at this LOD
    const vertStepWorld = cfg.chunkSize / (vertsX - 1);

    for (let vz = 0; vz < vertsZ; vz++) {
      for (let vx = 0; vx < vertsX; vx++) {
        const idx = vz * vertsX + vx;

        // Local position within chunk
        const localX = (vx / (vertsX - 1)) * cfg.chunkSize;
        const localZ = (vz / (vertsZ - 1)) * cfg.chunkSize;

        // World position for height lookup
        const worldX = chunkWorldX + localX;
        const worldZ = chunkWorldZ + localZ;

        const Y = getH(worldX, worldZ);

        positions[idx * 3] = localX;
        positions[idx * 3 + 1] = Y;
        positions[idx * 3 + 2] = localZ;

        // ── Normal via central differences ───────────────────────────────
        // For a Y-up surface P(x,z) = (x, h(x,z), z):
        //   T_x = (step, hR - hL, 0)
        //   T_z = (0,    hF - hN, step)   (F=+Z, N=-Z)
        //   N   = cross(T_z, T_x) → gives N.y > 0 for flat terrain ✓
        const hL = getH(worldX - vertStepWorld, worldZ);
        const hR = getH(worldX + vertStepWorld, worldZ);
        const hN = getH(worldX, worldZ - vertStepWorld); // Z-
        const hF = getH(worldX, worldZ + vertStepWorld); // Z+

        const nx = -(hR - hL);
        const ny = 2 * vertStepWorld;
        const nz = -(hF - hN);
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        normals[idx * 3] = nx / nLen;
        normals[idx * 3 + 1] = ny / nLen;
        normals[idx * 3 + 2] = nz / nLen;

        // ── UV: [0,1] within chunk for material tiling ───────────────────
        uvs[idx * 2] = vx / (vertsX - 1);
        uvs[idx * 2 + 1] = vz / (vertsZ - 1);
      }
    }

    // ── Index buffer ─────────────────────────────────────────────────────
    // Two CCW triangles per quad (when N.y > 0, double_sided in test phase)
    //   v00 v01 v10
    //   v10 v01 v11
    const quadCountX = vertsX - 1;
    const quadCountZ = vertsZ - 1;
    const mainIndexCount = quadCountX * quadCountZ * 6;

    // ── Skirt geometry ───────────────────────────────────────────────────
    // For each of the 4 border edges we add one strip of vertices (skirt twins)
    // pulled down by skirtDepth.  The strip quads close the gap between
    // adjacent chunks at different LOD levels (T-junctions are not fixed here
    // but skirts hide them visually from typical camera angles).
    //
    // Skirt vert layout (appended after main grid verts):
    //   [0 .. vertsX-1]         bottom edge (vz = 0)
    //   [vertsX .. 2*vertsX-1]  top edge    (vz = vertsZ-1)
    //   [2*vertsX .. 2*vertsX+vertsZ-1]   left  edge (vx = 0)
    //   [2*vertsX+vertsZ .. 2*vertsX+2*vertsZ-1] right edge (vx = vertsX-1)
    const skirtVertCount = skirtDepth > 0 ? 2 * vertsX + 2 * vertsZ : 0;
    // (each edge strip: (edgeVerts-1) quads * 2 tris * 3 verts)
    const skirtEdgeIndexCount =
      skirtDepth > 0 ? (vertsX - 1 + vertsX - 1 + vertsZ - 1 + vertsZ - 1) * 6 : 0;

    const totalVerts2 = totalVerts + skirtVertCount;
    const allPositions = new Float32Array(totalVerts2 * 3);
    const allNormals = new Float32Array(totalVerts2 * 3);
    const allUVs = new Float32Array(totalVerts2 * 2);

    allPositions.set(positions);
    allNormals.set(normals);
    allUVs.set(uvs);

    const totalIndices = mainIndexCount + skirtEdgeIndexCount;
    const indices = new Uint32Array(totalIndices);

    // Fill main indices
    let ii = 0;
    for (let qz = 0; qz < quadCountZ; qz++) {
      for (let qx = 0; qx < quadCountX; qx++) {
        const v00 = qz * vertsX + qx;
        const v10 = qz * vertsX + (qx + 1);
        const v01 = (qz + 1) * vertsX + qx;
        const v11 = (qz + 1) * vertsX + (qx + 1);

        indices[ii++] = v00;
        indices[ii++] = v01;
        indices[ii++] = v10;

        indices[ii++] = v10;
        indices[ii++] = v01;
        indices[ii++] = v11;
      }
    }

    if (skirtDepth > 0) {
      // Helper: write one skirt vertex into the extended arrays at slot (totalVerts + slot)
      const writeSkirtVert = (slot: number, srcMainIdx: number): void => {
        const dst = totalVerts + slot;
        allPositions[dst * 3] = allPositions[srcMainIdx * 3] ?? 0;
        allPositions[dst * 3 + 1] = (allPositions[srcMainIdx * 3 + 1] ?? 0) - skirtDepth;
        allPositions[dst * 3 + 2] = allPositions[srcMainIdx * 3 + 2] ?? 0;
        allNormals[dst * 3] = allNormals[srcMainIdx * 3] ?? 0;
        allNormals[dst * 3 + 1] = allNormals[srcMainIdx * 3 + 1] ?? 0;
        allNormals[dst * 3 + 2] = allNormals[srcMainIdx * 3 + 2] ?? 0;
        allUVs[dst * 2] = allUVs[srcMainIdx * 2] ?? 0;
        allUVs[dst * 2 + 1] = allUVs[srcMainIdx * 2 + 1] ?? 0;
      };

      // Helper: emit a skirt quad (two triangles) for edge verts a,b and their skirt twins sa,sb
      // Winding: faces outward from the chunk (double_sided so it doesn't matter much).
      const emitSkirtQuad = (a: number, b: number, sa: number, sb: number): void => {
        indices[ii++] = a;
        indices[ii++] = sa;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = sa;
        indices[ii++] = sb;
      };

      // ── Bottom edge (vz = 0): skirt slots 0..vertsX-1 ───────────────
      for (let vx = 0; vx < vertsX; vx++) {
        writeSkirtVert(vx, vx); // main vert = vz*vertsX+vx where vz=0
      }
      for (let vx = 0; vx < vertsX - 1; vx++) {
        emitSkirtQuad(vx, vx + 1, totalVerts + vx, totalVerts + vx + 1);
      }

      // ── Top edge (vz = vertsZ-1): skirt slots vertsX..2*vertsX-1 ────
      const topBase = totalVerts + vertsX;
      for (let vx = 0; vx < vertsX; vx++) {
        writeSkirtVert(vertsX + vx, (vertsZ - 1) * vertsX + vx);
      }
      for (let vx = 0; vx < vertsX - 1; vx++) {
        emitSkirtQuad(
          (vertsZ - 1) * vertsX + vx,
          (vertsZ - 1) * vertsX + vx + 1,
          topBase + vx,
          topBase + vx + 1,
        );
      }

      // ── Left edge (vx = 0): skirt slots 2*vertsX..2*vertsX+vertsZ-1 ─
      const leftBase = totalVerts + 2 * vertsX;
      for (let vz = 0; vz < vertsZ; vz++) {
        writeSkirtVert(2 * vertsX + vz, vz * vertsX);
      }
      for (let vz = 0; vz < vertsZ - 1; vz++) {
        emitSkirtQuad(vz * vertsX, (vz + 1) * vertsX, leftBase + vz, leftBase + vz + 1);
      }

      // ── Right edge (vx = vertsX-1): skirt slots 2*vertsX+vertsZ.. ───
      const rightBase = totalVerts + 2 * vertsX + vertsZ;
      for (let vz = 0; vz < vertsZ; vz++) {
        writeSkirtVert(2 * vertsX + vertsZ + vz, vz * vertsX + (vertsX - 1));
      }
      for (let vz = 0; vz < vertsZ - 1; vz++) {
        emitSkirtQuad(
          vz * vertsX + (vertsX - 1),
          (vz + 1) * vertsX + (vertsX - 1),
          rightBase + vz,
          rightBase + vz + 1,
        );
      }
    }

    return {
      attributes: {
        POSITION: allPositions,
        NORMAL: allNormals,
        TEXCOORD_0: allUVs,
        TANGENT: undefined,
      },
      indices,
    };
  }
}
