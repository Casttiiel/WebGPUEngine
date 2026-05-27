import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { Msg } from '../../../core/ecs/Msg';
import { HealthComponent } from '../HealthComponent';
import type { IMovementController } from '../movement/IMovementController';
import type { CameraComponent } from '../../render/CameraComponent';
import type { MarkSystem } from './MarkSystem';
import type { Entity } from '../../../core/ecs/Entity';

export interface LynxDashPunchSystemData {
  /** Units per second during the dash. Default: 28. */
  dashSpeed?: number;
  /** Maximum travel distance in units. Default: 12. */
  maxDashDistance?: number;
  /** Damage dealt on hit (collision or endpoint). Default: 60. */
  punchDamage?: number;
  /** Cooldown in seconds. Default: 10. */
  cooldownDuration?: number;
  /** Forward probe distance for mid-dash enemy collision check (units). Default: 1.0. */
  probeDistance?: number;
  /** Distance of the forward AoE cast at the end of the dash. Default: 1.5. */
  endHitRange?: number;
}

/**
 * LynxDashPunchSystem — Directional dash punch ability.
 *
 * Mechanics:
 *  - Activated by GameAction.ABILITY_Q (while cooldown is zero).
 *  - Launches the character in the current camera look direction (full 3D, including Y).
 *  - While dashing, a forward raycast stops the dash when an enemy is hit.
 *  - On stop (collision or max distance reached), a short forward cast deals damage
 *    to any enemy directly ahead (endHitRange).
 *  - 10 s cooldown (configurable).
 *  - If the hit target was marked by MarkerShotSystem → cooldown resets to 0.
 */
export class LynxDashPunchSystem {
  private readonly dashSpeed: number;
  private readonly maxDashDistance: number;
  private readonly punchDamage: number;
  private readonly cooldownDuration: number;
  private readonly probeDistance: number;
  private readonly endHitRange: number;

  private dashDirection: vec3 = vec3.create();
  private distanceTraveled: number = 0;
  private cooldownTimer: number = 0;
  private active: boolean = false;

  constructor(data?: LynxDashPunchSystemData) {
    this.dashSpeed = data?.dashSpeed ?? 28;
    this.maxDashDistance = data?.maxDashDistance ?? 12;
    this.punchDamage = data?.punchDamage ?? 60;
    this.cooldownDuration = data?.cooldownDuration ?? 10;
    this.probeDistance = data?.probeDistance ?? 1.0;
    this.endHitRange = data?.endHitRange ?? 1.5;
  }

  // ── State queries ───────────────────────────────────────────────────────────

  public isActive(): boolean {
    return this.active;
  }

  public canActivate(): boolean {
    return !this.active && this.cooldownTimer <= 0;
  }

  public getCooldownTimer(): number {
    return this.cooldownTimer;
  }

  public getCooldownDuration(): number {
    return this.cooldownDuration;
  }

  // ── Input polling (call from IDLE state) ────────────────────────────────────

  /**
   * Checks for ABILITY_Q input and starts the dash if the cooldown allows.
   * Returns true if a dash was initiated this frame.
   */
  public tryStart(camera: CameraComponent): boolean {
    if (!this.canActivate()) return false;

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.ABILITY_Q)) return false;

    const front = camera.getCamera().getFront() as vec3;
    vec3.normalize(this.dashDirection, front);

    this.distanceTraveled = 0;
    this.active = true;
    this.cooldownTimer = this.cooldownDuration;
    return true;
  }

  // ── Cooldown tick (call every frame regardless of state) ───────────────────

  public tickCooldown(dt: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
    }
  }

  // ── Dash movement (call every frame while in DASHING state) ────────────────

  /**
   * Advances the dash by one frame.
   * Returns the velocity vector to pass into the controller's applyMovement().
   * When the dash completes (distance reached or enemy hit), resets `active` to
   * false — the controller should then switch back to IDLE.
   */
  public updateDashMovement(
    dt: number,
    controller: IMovementController,
    markSystem: MarkSystem,
  ): vec3 {
    if (!this.active) return vec3.create();

    const frameDistance = this.dashSpeed * dt;
    const remaining = this.maxDashDistance - this.distanceTraveled;

    if (remaining <= frameDistance) {
      // Reached the end of the dash — deal damage to whatever is directly ahead.
      this.dealEndDamage(controller, markSystem);
      this.active = false;
      return vec3.create();
    }

    // Stop the dash if an enemy is in the path — damage fires as endpoint cast.
    const hit = this.probeEnemyAhead(controller, this.probeDistance + frameDistance);
    if (hit) {
      this.dealEndDamage(controller, markSystem);
      this.active = false;
      return vec3.create();
    }

    this.distanceTraveled += frameDistance;
    return vec3.scale(vec3.create(), this.dashDirection, this.dashSpeed);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Casts a short ray in the dash direction from the character's position.
   * Returns the first entity with a HealthComponent in range, or null.
   */
  private probeEnemyAhead(controller: IMovementController, distance: number): Entity | null {
    const collider = controller.getCollider();
    const rb = collider.getRigidBody();
    const pos = rb.translation();

    const ray = new RAPIER.Ray(
      { x: pos.x, y: pos.y, z: pos.z },
      { x: this.dashDirection[0], y: this.dashDirection[1], z: this.dashDirection[2] },
    );

    const physics = Engine.getPhysics();
    const world = physics.getWorld();

    const hit = world.castRay(
      ray,
      distance,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      collider.getCollider(),
    );

    if (!hit) return null;

    const entityId = physics.getEntityIdFromCollider(hit.collider.handle);
    if (entityId === undefined) return null;

    const entity = Engine.getEntities().getEntityById(entityId);
    if (!entity) return null;

    const health = entity.getComponent('health') as HealthComponent | null;
    return health ? entity : null;
  }

  /**
   * Deals damage to a specific enemy entity.
   * If the enemy was marked, the cooldown is reset and the mark is cleared.
   */
  private dealDamage(target: Entity, markSystem: MarkSystem): void {
    target.sendMsg(
      Msg.damage({ amount: this.punchDamage, instigator: null, sourceTag: 'lynx_dash_punch' }),
    );

    if (markSystem.isMarked(target.id)) {
      this.cooldownTimer = 0;
      markSystem.clearMark(target.id);
    }
  }

  /**
   * At the end of the dash (collision or distance), damage any enemy directly
   * ahead. If no enemy but a world mark is nearby, consume it and reset cooldown.
   */
  private dealEndDamage(controller: IMovementController, markSystem: MarkSystem): void {
    const enemy = this.probeEnemyAhead(controller, this.endHitRange);
    if (enemy) {
      this.dealDamage(enemy, markSystem);
      return;
    }

    // Check for a world mark in range — dashing into one resets the cooldown
    const rb = controller.getCollider().getRigidBody();
    const t = rb.translation();
    const pos = vec3.fromValues(t.x, t.y, t.z);
    if (markSystem.clearWorldMarkNear(pos, this.endHitRange)) {
      this.cooldownTimer = 0;
    }
  }
}
