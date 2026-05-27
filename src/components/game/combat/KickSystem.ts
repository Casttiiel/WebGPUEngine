import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { IMovementController } from '../movement/IMovementController';
import type { IKickable } from './IKickable';

export interface KickSystemData {
  /** Distance ahead to detect enemies and walls (units). Default: 1.5. */
  detectionDistance?: number;
  /** Horizontal force (units/s) applied to the enemy on hit. Default: 12. */
  enemyKnockbackForce?: number;
  /** Upward force (units/s) applied to the enemy on hit — creates an arc. Default: 6. */
  enemyKnockbackUpForce?: number;
  /** Duration (seconds) the enemy's knockback overrides its AI movement. Default: 0.35. */
  enemyKnockbackDuration?: number;
  /** Cooldown between kicks in seconds. Default: 0.6. */
  cooldown?: number;
  /** Input disable time applied to the player when wall-kicking (seconds). Default: 0.12. */
  selfInputDisableTime?: number;
  /** Horizontal speed (units/s) applied to the player away from the wall on wall-kick. Default: 8. */
  wallKickHorizForce?: number;
}

/**
 * KickSystem — Unified kick ability for the Lynx controller.
 *
 * Mechanics (GameAction.KICK press):
 *  - Casts a ray forward (flat XZ) up to `detectionDistance`.
 *  - If an enemy (HealthComponent entity) is hit → applies a horizontal knockback
 *    impulse to the enemy via EnemyControllerComponent.applyKnockback().
 *  - If a static wall is hit and the player is in the air → pushes the player
 *    upward (wall-kick, same logic as the old WallKickSystem).
 *  - A short `cooldown` prevents button-mashing.
 *  - The wall-kick token resets each time the player lands (call onGrounded()).
 */
export class KickSystem {
  private readonly detectionDistance: number;
  private readonly enemyKnockbackForce: number;
  private readonly enemyKnockbackUpForce: number;
  private readonly enemyKnockbackDuration: number;
  private readonly cooldown: number;
  private readonly selfInputDisableTime: number;
  private readonly wallKickHorizForce: number;

  private cooldownTimer: number = 0;
  /** One wall-kick per air period — reset by onGrounded(). */
  private wallKickAvailable: boolean = true;

  constructor(
    private readonly controller: IMovementController,
    data?: KickSystemData,
  ) {
    this.detectionDistance = data?.detectionDistance ?? 1.5;
    this.enemyKnockbackForce = data?.enemyKnockbackForce ?? 12;
    this.enemyKnockbackUpForce = data?.enemyKnockbackUpForce ?? 6;
    this.enemyKnockbackDuration = data?.enemyKnockbackDuration ?? 0.8;
    this.cooldown = data?.cooldown ?? 0.6;
    this.selfInputDisableTime = data?.selfInputDisableTime ?? 0.5;
    this.wallKickHorizForce = data?.wallKickHorizForce ?? 8;
  }

  // ── Per-frame update (call from IDLE state) ────────────────────────────────

  public update(deltaTime: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= deltaTime;
      return;
    }

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.KICK)) return;

    const result = this.castForward();
    if (result.type === 'kickable') {
      this.kickTarget(result.kickable!, result.direction);
    } else if (result.type === 'wall') {
      this.wallKick(result.direction);
    }
    // If nothing kickable is in front, no effect and no cooldown consumed.
    else {
      return;
    }

    this.cooldownTimer = this.cooldown;
  }

  /** Call when the player touches the ground to restore the wall-kick token. */
  public onGrounded(): void {
    this.wallKickAvailable = true;
  }

  // ── State queries ───────────────────────────────────────────────────────────

  public getCooldownTimer(): number {
    return this.cooldownTimer;
  }

  public getCooldown(): number {
    return this.cooldown;
  }

  public getWallKickAvailable(): boolean {
    return this.wallKickAvailable;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private kickTarget(kickable: IKickable, kickDir: vec3): void {
    const impulse = vec3.scale(vec3.create(), kickDir, this.enemyKnockbackForce);
    impulse[1] = this.enemyKnockbackUpForce;
    kickable.applyKnockback(impulse, this.enemyKnockbackDuration);
  }

  private wallKick(wallFacing: vec3): void {
    if (!this.wallKickAvailable) return;
    if (this.controller.getIsGrounded()) return;

    this.wallKickAvailable = false;

    // Vertical: full jump arc via KCCMovement.
    this.controller.setVerticalVelocity(10.0);

    // Horizontal: push away from the wall (opposite of look direction, XZ only).
    const away = vec3.negate(vec3.create(), wallFacing);
    away[1] = 0;
    vec3.normalize(away, away);
    vec3.scale(away, away, this.wallKickHorizForce);
    this.controller.setHorizontalVelocity(away);

    this.controller.setInputDisableTimer(this.selfInputDisableTime);
  }

  /**
   * Raycasts forward (flat XZ, camera facing).
   * Returns the first IKickable hit, or a fixed wall, or nothing.
   */
  private castForward(): {
    type: 'kickable' | 'wall' | 'none';
    kickable?: IKickable;
    direction: vec3;
  } {
    const camera = this.controller.getCamera();
    const emptyDir = vec3.fromValues(0, 0, 1);
    if (!camera) return { type: 'none', direction: emptyDir };

    const facing = camera.getCamera().getFront() as vec3;
    facing[1] = 0;
    vec3.normalize(facing, facing);

    const origin = this.controller.getCollider().getRigidBody().translation();
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: facing[0], y: facing[1], z: facing[2] },
    );

    const physics = Engine.getPhysics();
    const world = physics.getWorld();

    const hit = world.castRay(
      ray,
      this.detectionDistance,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.controller.getCollider().getCollider(),
    );

    if (!hit) return { type: 'none', direction: facing };

    // Check if the hit collider belongs to a kickable entity.
    const entityId = physics.getEntityIdFromCollider(hit.collider.handle);
    if (entityId !== undefined) {
      const entity = Engine.getEntities().getEntityById(entityId);
      if (entity) {
        const kickable = entity.getComponent('kickable') as IKickable | null;
        if (kickable) return { type: 'kickable', kickable, direction: facing };
      }
    }

    // Not a kickable entity — treat as wall if the body is static/fixed.
    if (hit.collider.parent()?.bodyType() === RAPIER.RigidBodyType.Fixed) {
      return { type: 'wall', direction: facing };
    }

    return { type: 'none', direction: facing };
  }
}
