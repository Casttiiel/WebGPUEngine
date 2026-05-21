import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { Engine } from '../../core/engine/Engine';

// ── Blackboard keys ───────────────────────────────────────────────────────────
const K_LATERAL_DIR = '_fleeLat'; // +1 or -1
const K_LATERAL_FLIP = '_fleeLatFlip'; // wall-clock timestamp for next flip
const K_SEP_TIME = '_fleeSepTime'; // last separation scan timestamp
const K_SEP_PUSH = '_fleeSepPush'; // +1, 0, or -1

export interface FleeActionOptions {
  /** Enemy retreats when player is closer than this (metres). Default: 14 */
  fleeRadius?: number;
  /** Enemy stops retreating once player is beyond this distance (metres). Default: 10 */
  minFleeRadius?: number;
  /** Seconds between lateral direction flips. Default: 1.5 */
  lateralFlipInterval?: number;
  /** Movement speed multiplier while fleeing (uses enemy's base moveSpeed). Default: 1 */
  speedScale?: number;
}

/**
 * FleeAction — Passive-range movement node.
 *
 * Behaviour:
 *  NEAR (dist < fleeRadius):  Moves directly away from the player with a lateral
 *    component that flips direction periodically to avoid geometry lock-in.
 *    Natural peer-separation: scans every 0.5 s for nearby allies and adds a
 *    gentle lateral push so multiple passives disperse automatically.
 *
 *  GOOD (dist >= fleeRadius): Returns SUCCESS so the parent Sequence can hand
 *    off to a shoot node.
 *
 * Always returns RUNNING while fleeing so it keeps running in the BT.
 * Returns SUCCESS when the enemy is already at or beyond `fleeRadius`.
 */
export class FleeAction extends BehaviorNode {
  private readonly fleeRadius: number;
  private readonly minFleeRadius: number;
  private readonly lateralFlipInterval: number;
  private readonly speedScale: number;

  constructor(label = 'Flee', options: FleeActionOptions = {}) {
    super(label);
    this.fleeRadius = options.fleeRadius ?? 14;
    this.minFleeRadius = options.minFleeRadius ?? 10;
    this.lateralFlipInterval = options.lateralFlipInterval ?? 1.5;
    this.speedScale = options.speedScale ?? 1.0;
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');

    if (!target) return Status.SUCCESS; // no player known — nothing to flee from

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Already at safe distance — let the shooting node take over
    if (dist >= this.fleeRadius) return Status.SUCCESS;

    self.faceToward(target);

    const now = performance.now() / 1000;

    // Unit vector pointing AWAY from the player
    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    // away = -fwd
    const awayX = -dx * invDist;
    const awayZ = -dz * invDist;
    // right = fwd rotated 90° CW = (fwdZ, 0, -fwdX) → right of away = (-awayZ, 0, awayX)
    const rightX = -awayZ;
    const rightZ = awayX;

    // ── Lateral component (flips every lateralFlipInterval seconds) ───────────
    let lat = bb.get<number>(K_LATERAL_DIR, 1);
    const flipTime = bb.get<number>(K_LATERAL_FLIP, -9999);
    if (now >= flipTime) {
      lat = -lat;
      bb.set(K_LATERAL_DIR, lat);
      bb.set(K_LATERAL_FLIP, now + this.lateralFlipInterval + Math.random() * 0.5);
    }

    // ── Peer separation push (scanned every 0.5 s) ────────────────────────────
    const sep = this.computeSepPush(self, pos, now, bb);

    // Blend: 0.7 away + 0.4 lateral + 0.25 separation
    const latBlend = lat * 0.4 + sep * 0.25;
    const moveX = awayX * 0.7 + rightX * latBlend;
    const moveZ = awayZ * 0.7 + rightZ * latBlend;
    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);

    if (len > 0.001) {
      const move = vec3.fromValues(moveX / len, 0, moveZ / len);
      self.setDesiredHorizontal(move, self.getMoveSpeed() * this.speedScale);
    }

    return Status.RUNNING;
  }

  public reset(): void {
    // Stateless — blackboard keys are naturally reset by a new encounter
  }

  // ── Peer separation ───────────────────────────────────────────────────────

  private computeSepPush(
    self: EnemyControllerComponent,
    pos: vec3,
    now: number,
    bb: Blackboard,
  ): number {
    if (now - bb.get<number>(K_SEP_TIME, -9999) < 0.5) {
      return bb.get<number>(K_SEP_PUSH, 0);
    }
    bb.set(K_SEP_TIME, now);

    const SEP_RADIUS = 5.0; // passives spread wider than normal enemies
    const myEntity = self.getOwner();

    for (const e of Engine.getEntities().getAllEntities()) {
      if (e === myEntity) continue;
      // Only separate from the same enemy archetype
      if (!e.getComponent('passive_ranger_controller')) continue;

      const cap = e.getComponent('capsule_collider') as CapsuleColliderComponent | null;
      if (!cap) continue;

      const ot = cap.getRigidBody().translation();
      const toOtherX = ot.x - pos[0];
      const toOtherZ = ot.z - pos[2];
      const otherDist = Math.sqrt(toOtherX * toOtherX + toOtherZ * toOtherZ);
      if (otherDist < 0.001 || otherDist > SEP_RADIUS) continue;

      // Push perpendicular to the direction toward the other agent
      const nx = toOtherX / otherDist;
      const nz = toOtherZ / otherDist;
      // Cross product Y to determine push side
      const crossY = pos[0] * nz - pos[2] * nx; // simplified: any nonzero sign works
      const push = crossY >= 0 ? 1 : -1;
      bb.set(K_SEP_PUSH, push);
      return push;
    }

    bb.set(K_SEP_PUSH, 0);
    return 0;
  }
}
