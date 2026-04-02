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
    const waypoints: vec3[] = [];
    let node = goalIdx;
    while (node !== -1) {
      waypoints.push(vec3.clone(tris[node]!.centroid));
      node = parent[node]!;
    }
    waypoints.reverse();
    waypoints[0] = vec3.clone(actualStart);
    waypoints[waypoints.length - 1] = vec3.clone(actualGoal);
    return AStar._stringPull(waypoints);
  }

  /**
   * Simple string-pulling: removes intermediate waypoints that don't
   * represent a significant direction change (dot product threshold).
   * Equivalent to the first pass of the Funnel Algorithm without portal edges.
   */
  private static _stringPull(waypoints: vec3[]): vec3[] {
    if (waypoints.length <= 2) return waypoints;
    const result: vec3[] = [waypoints[0]!];
    for (let i = 1; i < waypoints.length - 1; i++) {
      const prev = result[result.length - 1]!;
      const curr = waypoints[i]!;
      const next = waypoints[i + 1]!;
      const d1 = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), curr, prev));
      const d2 = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), next, prev));
      if (vec3.dot(d1, d2) < 0.98) {
        result.push(curr);
      }
    }
    result.push(waypoints[waypoints.length - 1]!);
    return result;
  }
}
