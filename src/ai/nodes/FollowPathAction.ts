import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';

/** Minimum distance to consider an intermediate waypoint reached. */
const WAYPOINT_THRESHOLD = 1.2;
/** Minimum distance to consider the final goal reached. */
const ARRIVAL_THRESHOLD = 1.5;

/**
 * FollowPathAction
 *
 * Reads 'currentPath' (vec3[]) and '_pathIndex' (number) from the blackboard
 * and drives the agent toward each waypoint in sequence.
 *
 * Returns RUNNING while the agent is moving.
 * Returns SUCCESS when the agent arrives at the final waypoint.
 * Returns FAILURE if there is no valid path on the blackboard.
 */
export class FollowPathAction extends BehaviorNode {
  constructor(label = 'FollowPath') {
    super(label);
  }

  public tick(bb: Blackboard): Status {
    const path = bb.get<vec3[]>('currentPath');
    let idx = bb.get<number>('_pathIndex', 1);
    if (!path || idx >= path.length) return Status.FAILURE;

    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = path[idx]!;
    const dist = vec3.distance(pos, target);
    const isFinal = idx === path.length - 1;

    // Arrived at the final destination
    if (isFinal && dist < ARRIVAL_THRESHOLD) {
      bb.delete('currentPath');
      return Status.SUCCESS;
    }

    // Reached an intermediate waypoint — advance to the next
    if (dist < WAYPOINT_THRESHOLD && !isFinal) {
      idx++;
      bb.set('_pathIndex', idx);
      return Status.RUNNING;
    }

    // Steer toward current waypoint
    const dir = vec3.subtract(vec3.create(), target, pos);
    dir[1] = 0; // project onto XZ plane
    if (vec3.length(dir) > 0.001) {
      vec3.normalize(dir, dir);
      self.setDesiredHorizontal(dir);
      self.faceToward(target);
    }

    return Status.RUNNING;
  }

  public reset(): void {}
}
