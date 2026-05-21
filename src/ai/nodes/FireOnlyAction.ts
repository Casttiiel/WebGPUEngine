import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { BulletPoolComponent } from '../../components/game/BulletPoolComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { Engine } from '../../core/engine/Engine';

/** Y-offset from rigid-body centre to muzzle. */
const MUZZLE_HEIGHT = 0.3;

const K_NEXT_FIRE = '_foNextFire';
const K_BURST_SHOTS = '_foBurstShots';

export interface FireOnlyActionOptions {
  /** Entity name that holds the BulletPoolComponent (fallback if no own pool). */
  poolName?: string;
  /** Intra-burst fire rate in shots/second. Default: 2 */
  fireRate?: number;
  /** Number of shots per burst. Default: 1 */
  burstSize?: number;
  /** Seconds of pause between bursts. Default: 2 */
  burstPause?: number;
  /** Maximum range in metres — returns FAILURE if player is further. Default: 35 */
  maxRange?: number;
}

/**
 * FireOnlyAction — Shoots at the player WITHOUT changing movement.
 *
 * Handles burst/cooldown firing. Leaves all movement decisions to sibling
 * nodes (e.g. FleeAction). The enemy still faces the player each tick.
 *
 * Returns RUNNING while the player is in range, FAILURE otherwise.
 *
 * Blackboard keys used (prefixed _fo to avoid clashing with ShootAction):
 *   _foNextFire   — wall-clock time of the next allowed shot
 *   _foBurstShots — shots fired in the current burst
 */
export class FireOnlyAction extends BehaviorNode {
  private readonly poolName: string;
  private readonly maxRange: number;
  private readonly burstSize: number;
  private readonly inBurstInterval: number;
  private readonly burstPause: number;

  constructor(label = 'FireOnly', options: FireOnlyActionOptions = {}) {
    super(label);
    this.poolName = options.poolName ?? 'BulletManager';
    this.maxRange = options.maxRange ?? 35;
    this.burstSize = options.burstSize ?? 1;
    this.inBurstInterval = 1.0 / (options.fireRate ?? 2);
    this.burstPause = options.burstPause ?? 2.0;
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');
    if (!target) return Status.FAILURE;

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.maxRange) return Status.FAILURE;

    self.faceToward(target);

    const now = performance.now() / 1000;
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

  public reset(): void {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  private resolvePool(self: EnemyControllerComponent): BulletPoolComponent | null {
    const ownPool = self.getOwner().getComponent('bullet_pool') as BulletPoolComponent | null;
    if (ownPool) return ownPool;
    const entity = Engine.getEntities().getEntityByName(this.poolName);
    return (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
  }

  private getShooterBody(self: EnemyControllerComponent) {
    const cap = self.getOwner().getComponent('capsule_collider') as CapsuleColliderComponent | null;
    return cap?.getRigidBody() ?? undefined;
  }
}
