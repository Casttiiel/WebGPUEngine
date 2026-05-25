import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { AStar } from '../nav/AStar';
import { NavMesh } from '../nav/NavMesh';

/**
 * Re-request only when EITHER the goal OR the agent's starting position
 * has moved more than this many metres since the last computation.
 */
const REUSE_DISTANCE = 0.5;

/**
 * Minimum milliseconds between path recomputations for the same node.
 * Prevents multiple enemies from calling AStar.findPath() in the same frame
 * when the player moves (cache-miss thundering herd → multi-ms spike).
 * Each RequestPathAction instance also adds random jitter on construction to
 * ensure different enemies stagger their recomputations across time.
 */
const RECOMPUTE_COOLDOWN_MS = 300;

/**
 * Don't request a navmesh path when already within arrival range.
 * Returning FAILURE here lets the direct-movement fallback sequence handle
 * close-range pursuit cleanly, and prevents the 60x/sec Detour-call spam
 * that occurs when SteerAction returns SUCCESS (deletes currentPath) every
 * frame because the enemy is already adjacent to its target.
 * Must be slightly above SteerAction's ARRIVAL_STOP_RADIUS (1.5 m).
 */
const MIN_PATH_DISTANCE = 1.8;

/**
 * RequestPathAction
 *
 * Computes an A* path from the agent's current position to a target position
 * stored on the Blackboard and writes the result to the blackboard:
 *   - 'currentPath'                  → vec3[]  (waypoints, start → goal)
 *   - '_pathIndex'                   → number  (current waypoint index, starts at 1)
 *   - `_lastPathGoal_${targetKey}`   → vec3    (goal at the time of last computation)
 *   - `_lastPathStart_${targetKey}`  → vec3    (agent position at the time of last computation)
 *   - `_savedPath_${targetKey}`      → vec3[]  (copy restored if SteerAction deletes currentPath)
 *
 * Returns SUCCESS if a path was found (or the cached path is still valid).
 * Returns FAILURE if NavMesh is not built, goal is unreachable, or target is
 * already within MIN_PATH_DISTANCE (direct-movement fallback handles it).
 *
 * @param targetKey  Blackboard key of the target position. Default: 'playerPosition'.
 */
export class RequestPathAction extends BehaviorNode {
  private readonly targetKey: string;
  private readonly cacheKey: string;
  private readonly pathKey: string;

  /**
   * Earliest time (ms, performance.now()) at which this node is allowed to
   * call AStar.findPath() again. Initialised with random jitter so that
   * enemies that spawn together don't all recompute in the same frame.
   */
  private _nextComputeMs: number;

  constructor(targetKey = 'playerPosition', label?: string) {
    super(label ?? `RequestPath(${targetKey})`);
    this.targetKey = targetKey;
    this.cacheKey = `_lastPathGoal_${targetKey}`;
    this.pathKey = `_savedPath_${targetKey}`;
    this._nextComputeMs = performance.now() + Math.random() * RECOMPUTE_COOLDOWN_MS;
  }

  public tick(bb: Blackboard): Status {
    const from = bb.get<vec3>('position');
    const to = bb.get<vec3>(this.targetKey);
    if (!from || !to) return Status.FAILURE;
    if (!NavMesh.getInstance().isBuilt()) return Status.FAILURE;

    // Already within arrival range — skip navmesh entirely.
    if (vec3.distance(from, to) < MIN_PATH_DISTANCE) {
      bb.delete('currentPath');
      return Status.FAILURE;
    }

    const lastGoal = bb.get<vec3>(this.cacheKey);

    if (lastGoal) {
      const goalDist = vec3.distance(lastGoal, to);

      if (goalDist < REUSE_DISTANCE) {
        // Goal hasn't moved — restore path if SteerAction deleted it mid-sequence.
        const currentPath = bb.get<vec3[]>('currentPath');
        if (!currentPath || currentPath.length === 0) {
          const saved = bb.get<vec3[]>(this.pathKey);
          if (saved && saved.length > 0) {
            bb.set(
              'currentPath',
              saved.map((v) => vec3.clone(v)),
            );
            bb.set('_pathIndex', 1);
          }
        }
        return Status.SUCCESS;
      }

      //console.log(`[RPA:${this.targetKey}] STALE  goalΔ=${goalDist.toFixed(2)}m → recomputing`);
    }

    // Throttle: if the cooldown hasn't expired yet, keep following the
    // existing or saved path rather than calling into WASM this frame.
    // This prevents multiple enemies from calling AStar.findPath() in the
    // same frame when the player moves past the REUSE_DISTANCE threshold.
    const nowMs = performance.now();
    if (nowMs < this._nextComputeMs) {
      const currentPath = bb.get<vec3[]>('currentPath');
      if (currentPath && currentPath.length > 0) return Status.SUCCESS;
      const saved = bb.get<vec3[]>(this.pathKey);
      if (saved && saved.length > 0) {
        bb.set(
          'currentPath',
          saved.map((v) => vec3.clone(v)),
        );
        bb.set('_pathIndex', 1);
        return Status.SUCCESS;
      }
      return Status.FAILURE; // no path to reuse yet — let Selector fall through to direct movement
    }
    this._nextComputeMs = nowMs + RECOMPUTE_COOLDOWN_MS;

    const path = AStar.findPath(from, to);
    if (!path || path.length === 0) {
      bb.delete('currentPath');
      return Status.FAILURE;
    }

    bb.set<vec3[]>('currentPath', path);
    bb.set<vec3[]>(
      this.pathKey,
      path.map((v) => vec3.clone(v)),
    );
    bb.set<number>('_pathIndex', 1);
    bb.set<vec3>(this.cacheKey, vec3.clone(to));
    return Status.SUCCESS;
  }

  /** Path data lives on the Blackboard — nothing to reset on the node itself. */
  public reset(): void {}
}
