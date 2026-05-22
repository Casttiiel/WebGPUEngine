import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { BulletPoolComponent } from '../../components/game/BulletPoolComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { Engine } from '../../core/engine/Engine';

/**
 * Y-offset from the rigid-body CENTER (capsule midpoint) to the muzzle.
 * getRigidBody().translation() = capsule centre (~0.9 m for a 1.8 m enemy).
 * +0.3 → ~1.2 m above ground = chest level.
 */
const MUZZLE_HEIGHT = 0.3;

// ── Blackboard keys (prefixed with _ to avoid collisions) ─────────────────────
const K_NEXT_FIRE = '_nextFireTime';
const K_BURST_SHOTS = '_burstShots';
const K_STRAFE_DIR = '_strafeDir'; // +1 or -1
const K_STRAFE_FLIP = '_strafeFlipTime'; // wall-clock timestamp (seconds)
const K_RETREAT_LAT = '_retreatLat'; // +1 or -1
const K_RETREAT_FLIP = '_retreatFlipTime';
const K_SEP_TIME = '_sepCheckTime';
const K_SEP_PUSH = '_sepPush'; // +1, 0, or -1

/** Options for the ShootAction constructor. */
export interface ShootActionOptions {
  /** Entity name that holds the BulletPoolComponent (fallback if no own pool). */
  poolName?: string;
  /** Distance below which the enemy retreats away from the player. */
  optimalMin?: number;
  /** Distance above which the enemy arcs toward the player. */
  optimalMax?: number;
  /** Intra-burst fire rate in shots/second. */
  fireRate?: number;
  /** Number of shots per burst. */
  burstSize?: number;
  /** Seconds of pause between bursts. */
  burstPause?: number;
  /** Distance beyond which the node returns FAILURE. */
  maxRange?: number;
}

/**
 * ShootAction — Dynamic shooting behavior node.
 *
 * The enemy is NEVER static while this node runs. Movement driven by range:
 *
 *  FAR  (dist > optimalMax) — Arc toward the player with lateral sine oscillation.
 *  GOOD (optimalMin..Max)   — Constant strafing orbit, direction flips every 1-2 s.
 *  NEAR (dist < optimalMin) — Diagonal retreat; lateral component avoids pure back-pedal.
 *
 * Firing uses a burst/pause model: `burstSize` shots at `fireRate` shots/s,
 * then a `burstPause`-second gap before the next burst.
 *
 * Enemy separation: every 0.4 s this node checks for nearby aligned enemies and
 * blends in a lateral push so they spread apart naturally.
 */
export class ShootAction extends BehaviorNode {
  private readonly poolName: string;
  private readonly maxRange: number;
  private readonly optimalMin: number;
  private readonly optimalMax: number;
  private readonly burstSize: number;
  private readonly inBurstInterval: number;
  private readonly burstPause: number;

  constructor(label = 'Shoot', options: ShootActionOptions = {}) {
    super(label);
    this.poolName = options.poolName ?? 'BulletManager';
    this.maxRange = options.maxRange ?? 35;
    this.optimalMin = options.optimalMin ?? 8;
    this.optimalMax = options.optimalMax ?? 18;
    this.burstSize = options.burstSize ?? 3;
    this.inBurstInterval = 1.0 / (options.fireRate ?? 2.5);
    this.burstPause = options.burstPause ?? 1.2;
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');
    if (!target) return Status.FAILURE;

    // ── Distance (XZ only) ──────────────────────────────────────────────────
    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.maxRange) return Status.FAILURE;

    const now = performance.now() / 1000;

    // ── Always face the player ───────────────────────────────────────────────
    self.faceToward(target);

    // ── Axis vectors (XZ plane) ──────────────────────────────────────────────
    // fwd  = unit vector from self toward player
    // right = fwd rotated 90° CW in XZ  (enemy's right when facing the player)
    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    const fwd = vec3.fromValues(dx * invDist, 0, dz * invDist);
    const right = vec3.fromValues(fwd[2], 0, -fwd[0]);

    // ── Movement phase ───────────────────────────────────────────────────────
    const moveDir = vec3.create();

    if (dist < this.optimalMin) {
      // NEAR — retreat diagonally away from the player
      // Lateral component flips every 1.5–2.5 s → zig-zag, never purely blocked
      let lat = bb.get<number>(K_RETREAT_LAT, 1);
      const flipTime = bb.get<number>(K_RETREAT_FLIP, -9999);
      if (now >= flipTime) {
        lat = -lat;
        bb.set(K_RETREAT_LAT, lat);
        bb.set(K_RETREAT_FLIP, now + 1.5 + Math.random());
      }
      // 0.7 backward + 0.45 lateral → diagonal retreat, avoids geometry lock-in
      vec3.scaleAndAdd(moveDir, moveDir, fwd, -0.7);
      vec3.scaleAndAdd(moveDir, moveDir, right, lat * 0.45);
      vec3.normalize(moveDir, moveDir);
      vec3.scale(moveDir, moveDir, 0.85); // 85 % of moveSpeed
    } else if (dist > this.optimalMax) {
      // FAR — arc approach: sine-wave lateral oscillation on top of forward movement
      // ~2.2 rad/s → 1.4 s full cycle; amplitude 0.55 → ~30° arc
      const lateralOsc = Math.sin(now * 2.2) * 0.55;
      vec3.scaleAndAdd(moveDir, fwd, right, lateralOsc);
      vec3.normalize(moveDir, moveDir);
      vec3.scale(moveDir, moveDir, 0.85);
    } else {
      // GOOD — strafe/orbit around the player at full speed
      let strafeDir = bb.get<number>(K_STRAFE_DIR, 1);
      const flipTime = bb.get<number>(K_STRAFE_FLIP, -9999);
      if (now >= flipTime) {
        strafeDir = -strafeDir;
        bb.set(K_STRAFE_DIR, strafeDir);
        bb.set(K_STRAFE_FLIP, now + 1.2 + Math.random() * 0.8); // 1.2–2 s
      }

      // Blend in a separation push if another enemy is aligned with us and the player
      const sepPush = this.computeSepPush(self, pos, fwd, now, bb);

      vec3.set(moveDir, right[0] * strafeDir, 0, right[2] * strafeDir);
      if (sepPush !== 0) {
        vec3.scaleAndAdd(moveDir, moveDir, right, sepPush * 0.4);
      }
      vec3.normalize(moveDir, moveDir);
      // full moveSpeed — makes strafing enemies hardest to hit
    }

    self.setDesiredHorizontal(moveDir);

    // ── Burst fire ───────────────────────────────────────────────────────────
    const nextFireTime = bb.get<number>(K_NEXT_FIRE, -9999);
    if (now >= nextFireTime) {
      const pool = this.resolvePool(self);
      if (pool) {
        const bullet = pool.acquire();
        if (bullet) {
          const muzzle = vec3.fromValues(pos[0], pos[1] + MUZZLE_HEIGHT, pos[2]);
          const dir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), target, muzzle));
          bullet.fire(muzzle, dir, pool.release.bind(pool), this.getShooterBody(self));

          const shots = bb.get<number>(K_BURST_SHOTS, 0) + 1;
          if (shots >= this.burstSize) {
            bb.set(K_BURST_SHOTS, 0);
            bb.set(K_NEXT_FIRE, now + this.burstPause);
          } else {
            bb.set(K_BURST_SHOTS, shots);
            bb.set(K_NEXT_FIRE, now + this.inBurstInterval);
          }
        }
      }
    }

    return Status.RUNNING;
  }

  public override reset(): void {
    // All timing/direction state lives on the Blackboard — nothing local to clear.
  }

  /**
   * Returns a lateral push direction (+1 / 0 / -1) if another enemy is aligned
   * in the same forward cone as the player. Cached for 0.4 s between scans.
   */
  private computeSepPush(
    self: EnemyControllerComponent,
    pos: vec3,
    fwdNorm: vec3,
    now: number,
    bb: Blackboard,
  ): number {
    if (now - bb.get<number>(K_SEP_TIME, -9999) < 0.4) {
      return bb.get<number>(K_SEP_PUSH, 0);
    }
    bb.set(K_SEP_TIME, now);

    for (const ec of EnemyControllerComponent.getAll()) {
      if (ec === self) continue;
      const nbPos = ec.bb.get<vec3>('position');
      if (!nbPos) continue;
      const toOtherX = nbPos[0] - pos[0];
      const toOtherZ = nbPos[2] - pos[2];
      const otherDist = Math.sqrt(toOtherX * toOtherX + toOtherZ * toOtherZ);
      if (otherDist < 0.001 || otherDist > 12) continue;
      const nx = toOtherX / otherDist;
      const nz = toOtherZ / otherDist;
      // Only separate if the other enemy is in our forward cone toward the player
      if (nx * fwdNorm[0] + nz * fwdNorm[2] < 0.85) continue;
      // Y-component of cross(fwdNorm, toOther):
      //   > 0 → other is to our LEFT  → push RIGHT (+1)
      //   < 0 → other is to our RIGHT → push LEFT  (-1)
      const crossY = fwdNorm[0] * nz - fwdNorm[2] * nx;
      const push = crossY >= 0 ? 1 : -1;
      bb.set(K_SEP_PUSH, push);
      return push;
    }
    bb.set(K_SEP_PUSH, 0);
    return 0;
  }

  private resolvePool(self: EnemyControllerComponent): BulletPoolComponent | null {
    const ownPool = self.getOwner().getComponent('bullet_pool') as BulletPoolComponent | null;
    if (ownPool) return ownPool;
    const entity = Engine.getEntities().getEntityByName(this.poolName);
    return (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
  }

  private getShooterBody(self: EnemyControllerComponent): RAPIER.RigidBody | undefined {
    const cap = self.getOwner().getComponent('capsule_collider') as CapsuleColliderComponent | null;
    return cap?.getRigidBody() ?? undefined;
  }
}
