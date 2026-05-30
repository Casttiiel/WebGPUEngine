import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import { Msg } from '../../../core/ecs/Msg';
import { HealthComponent } from '../HealthComponent';
import type { IMovementController } from '../movement/IMovementController';
import type { CameraComponent } from '../../render/CameraComponent';
import type { Entity } from '../../../core/ecs/Entity';

const enum DashMode {
  DIRECTIONAL = 0,
  ENEMY_TARGETED = 1,
}

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
  /** How far past the enemy hit point to land when dashing through one (units). Default: 2.5. */
  throughOffset?: number;
}

/**
 * LynxDashPunchSystem — Directional dash punch ability.
 *
 * Mechanics:
 *  - Activated by GameAction.ABILITY_Q (while cooldown is zero).
 *  - If an enemy is in the look direction (within maxDashDistance) the dash locks on and
 *    travels THROUGH the enemy, landing behind them (throughOffset past the hit surface).
 *    Movement curve: fast start (1.4×), smooth end (1.0×) — ease-out.
 *    Damage fires as the player passes through the enemy's position.
 *  - If no enemy is found in the look direction, falls back to directional mode:
 *    constant speed in the camera look direction; stops on contact or at maxDashDistance.
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
  private readonly throughOffset: number;

  // ── Shared dash state ──
  private dashDirection: vec3 = vec3.create();
  private distanceTraveled: number = 0;
  private cooldownTimer: number = 0;
  private active: boolean = false;

  // ── Enemy-targeted dash state ──
  private dashMode: DashMode = DashMode.DIRECTIONAL;
  private dashTarget: vec3 = vec3.create(); // world-space landing point (behind enemy)
  private dashTotalDist: number = 0; // total distance for easing progress
  private targetEnemy: Entity | null = null; // locked enemy
  private targetEnemyPos: vec3 = vec3.create(); // frozen hit centre at dash start
  private damageDealt: boolean = false; // prevents double-hit in targeted mode

  constructor(data?: LynxDashPunchSystemData) {
    this.dashSpeed = data?.dashSpeed ?? 28;
    this.maxDashDistance = data?.maxDashDistance ?? 12;
    this.punchDamage = data?.punchDamage ?? 60;
    this.cooldownDuration = data?.cooldownDuration ?? 10;
    this.probeDistance = data?.probeDistance ?? 1.0;
    this.endHitRange = data?.endHitRange ?? 1.5;
    this.throughOffset = data?.throughOffset ?? 2.5;
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

  // ── Dash activation (called by LynxControllerComponent on ABILITY_E) ───────

  /**
   * Starts the dash toward the nearest enemy in the look direction (through-dash) or,
   * if no enemy is found, in the camera look direction (directional dash).
   * Returns false if already active or on cooldown.
   */
  public start(camera: CameraComponent, controller: IMovementController): boolean {
    if (!this.canActivate()) return false;

    const front = camera.getCamera().getFront() as vec3;
    vec3.normalize(this.dashDirection, front);

    // Scan for a lockable enemy in the look direction.
    const enemyData = this.scanEnemyAhead(controller, this.maxDashDistance);

    if (enemyData !== null) {
      const rb = controller.getCollider().getRigidBody();
      const t = rb.translation();
      const playerPos = vec3.fromValues(t.x, t.y, t.z);

      const totalDist = enemyData.toi + this.throughOffset;
      vec3.scaleAndAdd(this.dashTarget, playerPos, this.dashDirection, totalDist);
      this.dashTotalDist = totalDist;

      // Freeze the hit centre of the enemy for the damage proximity check.
      vec3.scaleAndAdd(this.targetEnemyPos, playerPos, this.dashDirection, enemyData.toi);

      this.dashMode = DashMode.ENEMY_TARGETED;
      this.targetEnemy = enemyData.entity;
      this.damageDealt = false;
    } else {
      this.dashMode = DashMode.DIRECTIONAL;
      this.targetEnemy = null;
    }

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
   * Returns the velocity vector to apply to the controller.
   * Returns a zero vector when done — the controller should switch back to IDLE.
   */
  public updateDashMovement(
    dt: number,
    controller: IMovementController,
    markSystem: MarkSystem | null,
  ): vec3 {
    if (!this.active) return vec3.create();

    if (this.dashMode === DashMode.ENEMY_TARGETED) {
      return this.updateEnemyTargetedDash(dt, controller, markSystem);
    }

    // --- DIRECTIONAL mode (original) ---
    const frameDistance = this.dashSpeed * dt;
    const remaining = this.maxDashDistance - this.distanceTraveled;

    if (remaining <= frameDistance) {
      this.dealEndDamage(controller, markSystem);
      this.active = false;
      return vec3.create();
    }

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
   * Enemy-targeted dash movement.
   * Steers dynamically toward `dashTarget` (behind the enemy).
   * Speed curve: 1.4× at launch → 1.0× at arrival (ease-out).
   * Deals damage as the player passes through the enemy's frozen position.
   */
  private updateEnemyTargetedDash(
    dt: number,
    controller: IMovementController,
    markSystem: MarkSystem | null,
  ): vec3 {
    const rb = controller.getCollider().getRigidBody();
    const t = rb.translation();
    const playerPos = vec3.fromValues(t.x, t.y, t.z);

    const toTarget = vec3.subtract(vec3.create(), this.dashTarget, playerPos);
    const distToTarget = vec3.length(toTarget);

    // Arrived — stop.
    if (distToTarget < 0.4) {
      this.tryDealTargetedDamage(markSystem);
      this.active = false;
      return vec3.create();
    }

    const dir = vec3.scale(vec3.create(), toTarget, 1 / distToTarget);

    // Progress: 0 at start → 1 at end (for ease-out speed curve).
    const progress =
      this.dashTotalDist > 0 ? Math.min(1.0 - distToTarget / this.dashTotalDist, 1.0) : 0;

    // Fast start (1.4×), smooth end (1.0×).
    const speed = this.dashSpeed * (1.4 - 0.4 * progress);

    // Damage fires once, when the player passes through the enemy centre.
    if (!this.damageDealt) {
      const distToEnemy = vec3.distance(playerPos, this.targetEnemyPos);
      if (distToEnemy < 1.5) {
        this.tryDealTargetedDamage(markSystem);
      }
    }

    this.distanceTraveled += speed * dt;
    return vec3.scale(vec3.create(), dir, speed);
  }

  /** Sends damage to the locked enemy exactly once. */
  private tryDealTargetedDamage(markSystem: MarkSystem | null): void {
    if (this.damageDealt || !this.targetEnemy) return;
    this.damageDealt = true;
    this.dealDamage(this.targetEnemy, markSystem);
  }

  /**
   * Scans the look direction for the first enemy within `distance`.
   * Returns the entity and the time-of-impact (distance along the ray), or null.
   */
  private scanEnemyAhead(
    controller: IMovementController,
    distance: number,
  ): { entity: Entity; toi: number } | null {
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
    if (!health) return null;

    return { entity, toi: hit.timeOfImpact };
  }

  /**
   * Casts a short ray in the dash direction from the character's position.
   * Returns the first entity with a HealthComponent in range, or null.
   */
  private probeEnemyAhead(controller: IMovementController, distance: number): Entity | null {
    return this.scanEnemyAhead(controller, distance)?.entity ?? null;
  }

  /**
   * Deals damage to a specific enemy entity.
   * If the enemy was marked, the cooldown is reset and the mark is cleared.
   */
  private dealDamage(target: Entity, markSystem: MarkSystem | null): void {
    target.sendMsg(
      Msg.damage({ amount: this.punchDamage, instigator: null, sourceTag: 'lynx_dash_punch' }),
    );

    if (markSystem?.isMarked(target.id)) {
      this.cooldownTimer = 0;
      markSystem.clearMark(target.id);
    }
  }

  /**
   * At the end of the directional dash (collision or distance), damage any enemy directly
   * ahead. If no enemy but a world mark is nearby, consume it and reset cooldown.
   */
  private dealEndDamage(controller: IMovementController, markSystem: MarkSystem | null): void {
    const enemy = this.probeEnemyAhead(controller, this.endHitRange);
    if (enemy) {
      this.dealDamage(enemy, markSystem);
      return;
    }

    if (!markSystem) return;

    const rb = controller.getCollider().getRigidBody();
    const t = rb.translation();
    const pos = vec3.fromValues(t.x, t.y, t.z);
    if (markSystem.clearWorldMarkNear(pos, this.endHitRange)) {
      this.cooldownTimer = 0;
    }
  }
}
