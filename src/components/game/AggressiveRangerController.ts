import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode } from '../../ai/BehaviorNode';
import { ShootAction } from '../../ai/nodes/ShootAction';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

/**
 * AggressiveRangerController — Enemigo B: Rango Agresivo
 *
 * A fast, aggressive ranged enemy that uses the standard Shoot+Strafe behavior
 * from the base controller, but fires homing projectiles in short bursts.
 *
 * Movement: arcs toward/away from the player and strafes at optimal range.
 * Projectile: HomingProjectileComponent — curves toward the player but is
 *   not a pure heatseeker (trackingStrength caps the turn rate).
 *
 * Component key: 'aggressive_ranger_controller'
 */
export class AggressiveRangerController extends EnemyControllerComponent {
  // ── Default stats ─────────────────────────────────────────────────────────

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 5.5,
      gravity: 9,
      acceleration: 10,
      ...data,
    });
  }

  // ── Swap in homing-burst ShootAction ──────────────────────────────────────

  protected override createShootAction(): BehaviorNode {
    return new ShootAction('HomingBurst', {
      poolName: 'HomingBulletManager',
      burstSize: 2,
      burstPause: 1.5,
      fireRate: 3.0,
      optimalMin: 6,
      optimalMax: 15,
      maxRange: 25,
    });
  }

  // ── Message registration ──────────────────────────────────────────────────

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'aggressive_ranger_controller', (comp) => {
      (comp as AggressiveRangerController).onDeath();
    });
    EnemyControllerComponent.registerDamagedHandler('aggressive_ranger_controller');
    EnemyControllerComponent.registerParryHitHandler('aggressive_ranger_controller');
  }
}
