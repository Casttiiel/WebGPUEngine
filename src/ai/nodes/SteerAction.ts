import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { Steering, RVONeighbor } from '../steering/Steering';
import { Engine } from '../../core/engine/Engine';

// ─── Tuning constants ─────────────────────────────────────────────────────────

/** Advance to the next waypoint when within this distance. */
const WAYPOINT_RADIUS = 1.2;
/** Begin the Arrival deceleration ramp this far from the final goal. */
const ARRIVAL_SLOW_RADIUS = 4.0;
/** Consider the agent "arrived" when within this distance of the final goal. */
const ARRIVAL_STOP_RADIUS = 1.5;
/** Maximum range at which Separation is active (metres). */
const SEPARATION_RADIUS = 2.5;
/** Weight of separation force relative to path-following speed. [0..1] */
const SEPARATION_WEIGHT = 0.55;
/** Per-agent capsule radius for RVO (should match the physics collider radius). */
const RVO_AGENT_RADIUS = 0.4;
/** Seconds of look-ahead for RVO collision detection. */
const RVO_TIME_HORIZON = 2.0;
/** Maximum query range for collecting RVO neighbors (optimisation gate). */
const RVO_QUERY_RANGE = RVO_AGENT_RADIUS * 2 + 8.0;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * SteerAction — Local navigation layer (Behavior Tree leaf node).
 *
 * Reads the path written by `RequestPathAction` from the Blackboard and drives
 * the agent each tick through a three-tier steering pipeline:
 *
 *   1. Path Following  — moves toward the current NavMesh waypoint.
 *                        Arrive deceleration kicks in near the final goal.
 *   2. Separation      — adds a short-range repulsion force from nearby agents
 *                        so enemies never stack on top of each other.
 *   3. RVO             — adjusts the combined velocity using Reciprocal Velocity
 *                        Obstacles so moving agents smoothly yield to each other
 *                        without explicit coordination (Van den Berg et al., 2008).
 *
 * Returns:
 *   RUNNING — agent is moving toward the goal.
 *   SUCCESS — agent arrived at the final waypoint (path deleted from blackboard).
 *   FAILURE — no valid path on the blackboard.
 *
 * Blackboard keys read:
 *   'currentPath'  → vec3[]
 *   '_pathIndex'   → number
 *   'position'     → vec3
 *   'self'         → EnemyControllerComponent
 *
 * Blackboard keys written:
 *   '_pathIndex'   → number (incremented when a waypoint is reached)
 */
export class SteerAction extends BehaviorNode {
  constructor(label = 'Steer') {
    super(label);
  }

  public tick(bb: Blackboard): Status {
    const path = bb.get<vec3[]>('currentPath');
    let idx = bb.get<number>('_pathIndex', 1);

    if (!path || path.length === 0 || idx >= path.length) return Status.FAILURE;

    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const moveSpeed = self.getMoveSpeed();

    // ── 1. Path Following + Arrive ───────────────────────────────────────────
    const {
      vel: pathVel,
      nextIdx,
      done,
    } = Steering.pathFollow(
      pos,
      path,
      idx,
      moveSpeed,
      WAYPOINT_RADIUS,
      ARRIVAL_SLOW_RADIUS,
      ARRIVAL_STOP_RADIUS,
    );

    if (done) {
      bb.delete('currentPath');
      return Status.SUCCESS;
    }

    if (nextIdx !== idx) {
      bb.set('_pathIndex', nextIdx);
      idx = nextIdx;
    }

    let vx = pathVel[0];
    let vz = pathVel[2];

    // ── 2. Separation ─────────────────────────────────────────────────────────
    const neighborPositions = this.collectNeighborPositions(self, pos, SEPARATION_RADIUS);
    if (neighborPositions.length > 0) {
      const sep = Steering.separate(pos, neighborPositions, SEPARATION_RADIUS);
      const sepLen = Math.sqrt(sep[0] * sep[0] + sep[2] * sep[2]);
      if (sepLen > 0.001) {
        // Blend: separation is added on top of path velocity (weighted by SEPARATION_WEIGHT)
        vx += (sep[0] / sepLen) * SEPARATION_WEIGHT * moveSpeed;
        vz += (sep[2] / sepLen) * SEPARATION_WEIGHT * moveSpeed;
      }
    }

    // ── 3. RVO ────────────────────────────────────────────────────────────────
    const rvoNeighbors = this.collectRVONeighbors(self, pos, RVO_QUERY_RANGE);
    const prefVel = vec3.fromValues(vx, 0, vz);
    const currentVel = self.getCurrentHorizontal();
    const finalVel = Steering.rvo(
      pos,
      prefVel,
      currentVel,
      rvoNeighbors,
      RVO_AGENT_RADIUS,
      RVO_TIME_HORIZON,
      moveSpeed * 1.2, // allow slight speed boost for avoidance manoeuvres
    );

    // ── 4. Apply to controller ────────────────────────────────────────────────
    const finalSpeed = Math.sqrt(finalVel[0] ** 2 + finalVel[2] ** 2);
    if (finalSpeed > 0.001) {
      const dir = vec3.fromValues(finalVel[0] / finalSpeed, 0, finalVel[2] / finalSpeed);
      self.setDesiredHorizontal(dir, Math.min(finalSpeed, moveSpeed * 1.2));
      // Always face toward the next waypoint — not the raw velocity direction,
      // so rotation stays smooth even during avoidance side-steps.
      if (idx < path.length) {
        self.faceToward(path[idx]!);
      }
    }

    return Status.RUNNING;
  }

  public reset(): void {}

  // ─── Neighbor collection helpers ─────────────────────────────────────────

  /** Returns positions of all enemy agents (except self) within `range`. */
  private collectNeighborPositions(
    self: EnemyControllerComponent,
    pos: vec3,
    range: number,
  ): vec3[] {
    const result: vec3[] = [];
    for (const entity of Engine.getEntities().getAllEntities()) {
      const ec = entity.getComponent('enemy_controller') as EnemyControllerComponent | null;
      if (!ec || ec === self) continue;
      const nbPos = ec.bb.get<vec3>('position');
      if (!nbPos) continue;
      const dx = nbPos[0] - pos[0];
      const dz = nbPos[2] - pos[2];
      if (dx * dx + dz * dz < range * range) result.push(nbPos);
    }
    return result;
  }

  /** Returns positions + velocities of enemy agents (except self) within `range`. */
  private collectRVONeighbors(
    self: EnemyControllerComponent,
    pos: vec3,
    range: number,
  ): RVONeighbor[] {
    const result: RVONeighbor[] = [];
    for (const entity of Engine.getEntities().getAllEntities()) {
      const ec = entity.getComponent('enemy_controller') as EnemyControllerComponent | null;
      if (!ec || ec === self) continue;
      const nbPos = ec.bb.get<vec3>('position');
      if (!nbPos) continue;
      const dx = nbPos[0] - pos[0];
      const dz = nbPos[2] - pos[2];
      if (dx * dx + dz * dz < range * range) {
        result.push({ pos: nbPos, vel: ec.getCurrentHorizontal() });
      }
    }
    return result;
  }
}
