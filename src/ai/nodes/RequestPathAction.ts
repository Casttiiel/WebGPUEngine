import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { AStar } from '../nav/AStar';
import { NavMesh } from '../nav/NavMesh';

/** Re-request only when the goal moves more than this many metres. */
const REUSE_DISTANCE = 0.5;

/**
 * RequestPathAction
 *
 * Computes an A* path from the agent's current position to a target position
 * stored on the Blackboard and writes the result to the blackboard:
 *   - 'currentPath'               → vec3[]  (waypoints, start → goal)
 *   - '_pathIndex'                → number  (current waypoint index, starts at 1)
 *   - `_lastPathGoal_${targetKey}`→ vec3    (goal position at the time of last computation)
 *
 * Returns SUCCESS if a path was found (or the cached path is still valid).
 * Returns FAILURE if the NavMesh is not built or the goal is unreachable.
 *
 * @param targetKey  Blackboard key of the target position. Default: 'playerPosition'.
 */
export class RequestPathAction extends BehaviorNode {
  private readonly targetKey: string;
  private readonly cacheKey: string;

  constructor(targetKey = 'playerPosition', label?: string) {
    super(label ?? `RequestPath(${targetKey})`);
    this.targetKey = targetKey;
    this.cacheKey = `_lastPathGoal_${targetKey}`;
  }

  public tick(bb: Blackboard): Status {
    const from = bb.get<vec3>('position');
    const to = bb.get<vec3>(this.targetKey);
    if (!from || !to) return Status.FAILURE;
    if (!NavMesh.getInstance().isBuilt()) return Status.FAILURE;

    // Reuse existing path if the goal hasn't moved significantly
    const lastGoal = bb.get<vec3>(this.cacheKey);
    const currentPath = bb.get<vec3[]>('currentPath');
    if (lastGoal && currentPath && currentPath.length > 0) {
      if (vec3.distance(lastGoal, to) < REUSE_DISTANCE) return Status.SUCCESS;
    }

    const path = AStar.findPath(from, to);
    if (!path || path.length === 0) {
      bb.delete('currentPath');
      return Status.FAILURE;
    }

    bb.set<vec3[]>('currentPath', path);
    bb.set<number>('_pathIndex', 1); // index 0 is the agent's current position
    bb.set<vec3>(this.cacheKey, vec3.clone(to));
    return Status.SUCCESS;
  }

  /** Path data lives on the Blackboard — nothing to reset on the node itself. */
  public reset(): void {}
}
