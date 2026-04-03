import { vec3 } from 'gl-matrix';
import { NavMesh } from './NavMesh';

/**
 * AStar — pathfinding interface backed by Recast/Detour NavMeshQuery.
 *
 * Replaces the previous custom A* + string-pull implementation.
 * NavMeshQuery.computePath() uses Detour's findPath (corridor) +
 * findStraightPath (full Funnel Algorithm) internally, which gives
 * smooth, obstacle-aware paths without any custom post-processing.
 *
 * Usage:
 *   const path = AStar.findPath(enemyWorldPos, playerWorldPos);
 *   // Returns [start, wp1, ..., goal] or null if unreachable.
 */
export class AStar {
  /**
   * Finds the shortest smooth path from `start` to `goal` using Detour.
   *
   * @returns Array of world-space waypoints (start ? goal), or null if unreachable.
   */
  public static findPath(start: vec3, goal: vec3): vec3[] | null {
    const mesh = NavMesh.getInstance();
    if (!mesh.isBuilt()) return null;

    const query = mesh.getQuery();
    if (!query) return null;

    const { success, path } = query.computePath(
      { x: start[0], y: start[1], z: start[2] },
      { x: goal[0],  y: goal[1],  z: goal[2]  },
    );

    if (!success || !path || path.length === 0) return null;

    return path.map((p) => vec3.fromValues(p.x, p.y, p.z));
  }
}
