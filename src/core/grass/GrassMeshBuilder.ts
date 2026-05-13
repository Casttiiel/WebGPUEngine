// ---------------------------------------------------------------------------
// GrassMeshBuilder — procedural cross-blade grass mesh
// ---------------------------------------------------------------------------
// Produces two quads arranged as an X cross in the XY/ZY planes.
// Local space: base at Y=0, tip at Y=1.0, half-width W=0.25 (total 0.5 units).
// All normals point straight up (0,1,0) for uniform top-lit shading.
// TANGENT is omitted — Mesh.setData() auto-computes it via mikktspace.
// UV: U=0..1 across blade width, V=1 at base → V=0 at tip.
// ---------------------------------------------------------------------------

/** Minimal raw mesh data compatible with Mesh.get() / RenderComponent.readMesh(). */
export interface GrassMeshData {
  attributes: {
    POSITION: Float32Array;
    NORMAL: Float32Array;
    TEXCOORD_0: Float32Array;
    TANGENT: undefined;
  };
  indices: Uint16Array;
}

export class GrassMeshBuilder {
  /**
   * Returns a cross-blade mesh (2 quads at 90°) in local space.
   *   Base at Y=0, tip at Y=1.  Width = 0.5 units.
   *   Use instance.scale to vary blade height per instance.
   */
  public static build(): GrassMeshData {
    const W = 0.25; // half-width
    const H = 1.0; // height

    // 8 vertices — quad 0 in XY plane, quad 1 in ZY plane
    // clang-format off
    const positions = new Float32Array([
      // Quad 0 (in XY plane — facing ±Z)
      -W,
      0,
      0, //  0  bottom-left
      W,
      0,
      0, //  1  bottom-right
      -W,
      H,
      0, //  2  top-left
      W,
      H,
      0, //  3  top-right
      // Quad 1 (in ZY plane — facing ±X)
      0,
      0,
      -W, //  4  bottom-left
      0,
      0,
      W, //  5  bottom-right
      0,
      H,
      -W, //  6  top-left
      0,
      H,
      W, //  7  top-right
    ]);

    // All normals point up → consistent diffuse shading regardless of camera angle.
    const normals = new Float32Array([
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0, // quad 0
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0, // quad 1
    ]);

    // UV: U = 0 (left) → 1 (right), V = 1 (base) → 0 (tip)
    const uvs = new Float32Array([
      // Quad 0
      0, 1, 1, 1, 0, 0, 1, 0,
      // Quad 1
      0, 1, 1, 1, 0, 0, 1, 0,
    ]);

    // 4 triangles (12 indices) — double-sided via technique rasteriser mode.
    const indices = new Uint16Array([
      // Quad 0
      0, 1, 2, 1, 3, 2,
      // Quad 1
      4, 5, 6, 5, 7, 6,
    ]);

    return {
      attributes: {
        POSITION: positions,
        NORMAL: normals,
        TEXCOORD_0: uvs,
        TANGENT: undefined,
      },
      indices,
    };
  }
}
