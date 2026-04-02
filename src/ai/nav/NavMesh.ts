import { vec3, mat4 } from 'gl-matrix';

export interface NavTriangle {
  readonly v0: vec3;
  readonly v1: vec3;
  readonly v2: vec3;
  readonly centroid: vec3;
  readonly index: number;
  /** Indices of adjacent triangles (share an edge), up to 3 entries. */
  adjacent: number[];
}

/**
 * NavMesh — singleton triangle graph used for:
 *  - AI pathfinding (A* over adjacent triangle graph)
 *  - Probe auto-placement (interior sampling)
 *
 * Built once from GLTFLoader when a node with extras.type === "navmesh" is found.
 * Query anywhere via NavMesh.getInstance().
 */
export class NavMesh {
  private static _instance: NavMesh | null = null;
  private _triangles: NavTriangle[] = [];
  private _built = false;

  private constructor() {}

  public static getInstance(): NavMesh {
    if (!NavMesh._instance) NavMesh._instance = new NavMesh();
    return NavMesh._instance;
  }

  public isBuilt(): boolean {
    return this._built;
  }

  public getTriangles(): readonly NavTriangle[] {
    return this._triangles;
  }

  /** Returns a copy of every triangle centroid. Used by ProbeAutoPlacement. */
  public getCentroids(): vec3[] {
    return this._triangles.map((t) => vec3.clone(t.centroid));
  }

  /**
   * Builds the navmesh from raw GLTF geometry.
   * @param positions  Flat Float32 vertex positions [x0,y0,z0, x1,y1,z1, …]
   * @param indices    Triangle index buffer
   * @param worldMatrix  Optional node-to-world transform applied to every vertex
   */
  public build(
    positions: Float32Array,
    indices: Uint32Array | Uint16Array,
    worldMatrix?: mat4,
  ): void {
    this._triangles = [];

    const vertCount = Math.floor(positions.length / 3);
    const verts: vec3[] = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const v = vec3.fromValues(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
      if (worldMatrix) vec3.transformMat4(v, v, worldMatrix);
      verts[i] = v;
    }

    const triCount = Math.floor(indices.length / 3);
    for (let i = 0; i < triCount; i++) {
      const i0 = indices[i * 3]!;
      const i1 = indices[i * 3 + 1]!;
      const i2 = indices[i * 3 + 2]!;
      const v0 = vec3.clone(verts[i0]!);
      const v1 = vec3.clone(verts[i1]!);
      const v2 = vec3.clone(verts[i2]!);
      const centroid = vec3.fromValues(
        (v0[0] + v1[0] + v2[0]) / 3,
        (v0[1] + v1[1] + v2[1]) / 3,
        (v0[2] + v1[2] + v2[2]) / 3,
      );
      this._triangles.push({ v0, v1, v2, centroid, index: i, adjacent: [] });
    }

    this._buildAdjacency();
    this._built = true;
    console.log(`[NavMesh] Built — ${this._triangles.length} triangles`);
  }

  private _buildAdjacency(): void {
    const edgeMap = new Map<string, number>();
    for (const tri of this._triangles) {
      const edges: [vec3, vec3][] = [
        [tri.v0, tri.v1],
        [tri.v1, tri.v2],
        [tri.v2, tri.v0],
      ];
      for (const [a, b] of edges) {
        const key = this._edgeKey(a, b);
        const existing = edgeMap.get(key);
        if (existing !== undefined) {
          if (!tri.adjacent.includes(existing)) tri.adjacent.push(existing);
          if (!this._triangles[existing]!.adjacent.includes(tri.index))
            this._triangles[existing]!.adjacent.push(tri.index);
        } else {
          edgeMap.set(key, tri.index);
        }
      }
    }
  }

  /** Canonical sorted edge key — fixed precision to avoid float drift. */
  private _edgeKey(a: vec3, b: vec3): string {
    const cmp = a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2];
    const lo = cmp < 0 ? a : b;
    const hi = cmp < 0 ? b : a;
    return (
      `${lo[0].toFixed(4)},${lo[1].toFixed(4)},${lo[2].toFixed(4)}` +
      `|${hi[0].toFixed(4)},${hi[1].toFixed(4)},${hi[2].toFixed(4)}`
    );
  }

  /**
   * Returns the index of the triangle whose centroid is nearest to worldPos.
   * O(N) — acceptable for typical nav meshes (< 10,000 triangles).
   */
  public findClosestTriangleIndex(worldPos: vec3): number {
    let best = -1;
    let bestDist = Infinity;
    for (const tri of this._triangles) {
      const d = vec3.squaredDistance(tri.centroid, worldPos);
      if (d < bestDist) {
        bestDist = d;
        best = tri.index;
      }
    }
    return best;
  }

  public dispose(): void {
    this._triangles = [];
    this._built = false;
  }
}
