import { vec3 } from 'gl-matrix';
import { NavMesh, NavTriangle } from './NavMesh';

/** Minimal binary min-heap keyed by `f` cost (g + h). */
class MinHeap {
  private heap: { idx: number; f: number }[] = [];

  push(idx: number, f: number): void {
    this.heap.push({ idx, f });
    this._up(this.heap.length - 1);
  }

  pop(): { idx: number; f: number } | undefined {
    if (!this.heap.length) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._down(0);
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }

  private _up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p]!.f <= this.heap[i]!.f) break;
      const tmp = this.heap[p]!;
      this.heap[p] = this.heap[i]!;
      this.heap[i] = tmp;
      i = p;
    }
  }

  private _down(i: number): void {
    const n = this.heap.length;
    while (true) {
      let min = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.heap[l]!.f < this.heap[min]!.f) min = l;
      if (r < n && this.heap[r]!.f < this.heap[min]!.f) min = r;
      if (min === i) break;
      const tmp = this.heap[min]!;
      this.heap[min] = this.heap[i]!;
      this.heap[i] = tmp;
      i = min;
    }
  }
}

/**
 * A* pathfinding over the NavMesh triangle adjacency graph.
 *
 * Usage:
 *   const path = AStar.findPath(enemyWorldPos, playerWorldPos);
 *   // Returns [start, wp1, ..., goal] or null if unreachable.
 */
export class AStar {
  /**
   * Finds the shortest path from `start` to `goal` on the NavMesh.
   * Both positions are snapped to the nearest triangle centroid.
   *
   * @returns Array of world-space waypoints (start → goal), or null if unreachable.
   */
  public static findPath(start: vec3, goal: vec3): vec3[] | null {
    const mesh = NavMesh.getInstance();
    if (!mesh.isBuilt()) return null;

    const tris = mesh.getTriangles();
    if (tris.length === 0) return null;

    const startIdx = mesh.findClosestTriangleIndex(start);
    const goalIdx = mesh.findClosestTriangleIndex(goal);
    if (startIdx === -1 || goalIdx === -1) return null;
    if (startIdx === goalIdx) return [vec3.clone(start), vec3.clone(goal)];

    const goalCentroid = tris[goalIdx]!.centroid;
    const n = tris.length;
    const gCost = new Float32Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);

    const open = new MinHeap();
    gCost[startIdx] = 0;
    open.push(startIdx, vec3.distance(tris[startIdx]!.centroid, goalCentroid));

    while (open.size > 0) {
      const { idx: curr } = open.pop()!;

      if (curr === goalIdx) {
        return AStar._reconstructPath(tris, parent, curr, start, goal);
      }

      if (closed[curr]) continue;
      closed[curr] = 1;

      for (const neighborIdx of tris[curr]!.adjacent) {
        if (closed[neighborIdx]) continue;
        const tentativeG =
          gCost[curr]! + vec3.distance(tris[curr]!.centroid, tris[neighborIdx]!.centroid);
        if (tentativeG < gCost[neighborIdx]!) {
          gCost[neighborIdx] = tentativeG;
          parent[neighborIdx] = curr;
          const h = vec3.distance(tris[neighborIdx]!.centroid, goalCentroid);
          open.push(neighborIdx, tentativeG + h);
        }
      }
    }

    return null; // No path found — goal unreachable
  }

  private static _reconstructPath(
    tris: readonly NavTriangle[],
    parent: Int32Array,
    goalIdx: number,
    actualStart: vec3,
    actualGoal: vec3,
  ): vec3[] {
    // Rebuild the triangle sequence (goal → start, then reverse)
    const triSeq: number[] = [];
    let node = goalIdx;
    while (node !== -1) {
      triSeq.push(node);
      node = parent[node]!;
    }
    triSeq.reverse();

    // Build waypoints using shared portal-edge midpoints rather than centroids.
    // This keeps the path physically accurate (midpoints lie on walkable edges)
    // and eliminates the zig-zag that comes from alternating triangle centroids.
    const waypoints: vec3[] = [vec3.clone(actualStart)];
    for (let i = 0; i < triSeq.length - 1; i++) {
      const t1 = tris[triSeq[i]!]!;
      const t2 = tris[triSeq[i + 1]!]!;
      const mid = AStar._sharedEdgeMidpoint(t1, t2);
      if (mid) waypoints.push(mid);
    }
    waypoints.push(vec3.clone(actualGoal));

    return AStar._stringPull(waypoints);
  }

  /**
   * Finds the midpoint of the shared edge between two adjacent NavTriangles.
   * Returns null if the triangles don't share an edge (shouldn't happen for
   * adjacent pairs from the A* path).
   */
  private static _sharedEdgeMidpoint(t1: NavTriangle, t2: NavTriangle): vec3 | null {
    const verts1 = [t1.v0, t1.v1, t1.v2];
    const verts2 = [t2.v0, t2.v1, t2.v2];
    const shared: vec3[] = [];
    for (const v1 of verts1) {
      for (const v2 of verts2) {
        if (vec3.squaredDistance(v1, v2) < 0.0001) {
          shared.push(v1);
          if (shared.length === 2) return vec3.lerp(vec3.create(), shared[0]!, shared[1]!, 0.5);
        }
      }
    }
    return null;
  }

  /**
   * Greedy string-pull: from each anchor point, jump as far ahead as possible
   * while the overall direction from the anchor stays consistent (dot ≥ 0.97,
   * i.e. within ~14°). This collapses quasi-collinear waypoints in open space
   * while preserving genuine turns (e.g. around corners or columns).
   */
  private static _stringPull(waypoints: vec3[]): vec3[] {
    if (waypoints.length <= 2) return waypoints;
    const result: vec3[] = [waypoints[0]!];
    let anchor = 0;

    while (anchor < waypoints.length - 1) {
      // Initial direction from this anchor
      const dAnchorFirst = vec3.normalize(
        vec3.create(),
        vec3.subtract(vec3.create(), waypoints[anchor + 1]!, waypoints[anchor]!),
      );

      let furthest = anchor + 1;
      for (let j = anchor + 2; j < waypoints.length; j++) {
        const dAnchorJ = vec3.normalize(
          vec3.create(),
          vec3.subtract(vec3.create(), waypoints[j]!, waypoints[anchor]!),
        );
        if (vec3.dot(dAnchorFirst, dAnchorJ) >= 0.97) {
          furthest = j; // still heading the same way — skip the intermediate point
        } else {
          break; // direction has changed significantly — stop here
        }
      }

      result.push(waypoints[furthest]!);
      anchor = furthest;
    }

    return result;
  }
}
