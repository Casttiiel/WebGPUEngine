import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { GrappleTargetType } from '../../../types/GrappleTargetType.enum';
import { TransformComponent } from '../../core/TransformComponent';
import { HealthComponent } from '../HealthComponent';
import { ChargeTargetComponent } from '../ChargeTargetComponent';
import { Msg } from '../../../core/ecs/Msg';
import { GrappleSystem, GrappleSystemData } from '../movement/GrappleSystem';
import type { IMovementController } from '../movement/IMovementController';
import type { Entity } from '../../../core/ecs/Entity';
import type { BloodComponent } from '../BloodComponent';

export interface ChargeSystemData extends GrappleSystemData {
  /** Cooldown in seconds between charges. Default 3. */
  cooldown?: number;
  /** Fraction of max HP to restore on kill. Default 0.05 (5%). */
  healPercent?: number;
  /** Flat blood amount to restore on kill. Default 40. */
  bloodRestore?: number;
  /** HP ratio threshold below which an enemy is eligible (≤ this value). Default 0.2 (20%). */
  hpRatioThreshold?: number;
  /**
   * Minimum dot product between the horizontal camera forward and the direction
   * to the enemy. Enemies behind or to the side are ignored. Default 0.3.
   */
  forwardDot?: number;
  /** Callback returning the player's HealthComponent. */
  getHealth: () => HealthComponent | null;
  /** Callback returning the player's BloodComponent. */
  getBlood: () => BloodComponent | null;
}

/**
 * ChargeSystem — Bloodmancer's Middle-Mouse-Button ability.
 *
 * Owns its GrappleSystem internally (the Bloodmancer has no standalone grapple
 * ability; the dash movement is solely used for this kill-charge).
 *
 * Uses ChargeTargetComponent's physics trigger registry to detect eligible
 * enemies in range (≤20% HP, roughly in-front of camera) without iterating
 * every entity. When activated, dashes to the enemy via the internal
 * GrappleSystem; on arrival kills it and rewards 5% HP + 40 blood.
 */
export class ChargeSystem {
  private readonly grappleSystem: GrappleSystem;

  private readonly cooldown: number;
  private readonly healPercent: number;
  private readonly bloodRestore: number;
  private readonly hpRatioThreshold: number;
  private readonly forwardDot: number;
  private readonly getHealth: () => HealthComponent | null;
  private readonly getBlood: () => BloodComponent | null;

  private targetEntity: Entity | null = null;
  private wasActive: boolean = false;
  private cooldownTimer: number = 0;

  constructor(controller: IMovementController, data: ChargeSystemData) {
    this.grappleSystem = new GrappleSystem(controller, data);
    this.cooldown = data.cooldown ?? 3.0;
    this.healPercent = data.healPercent ?? 0.05;
    this.bloodRestore = data.bloodRestore ?? 40;
    this.hpRatioThreshold = data.hpRatioThreshold ?? 0.2;
    this.forwardDot = data.forwardDot ?? 0.3;
    this.getHealth = data.getHealth;
    this.getBlood = data.getBlood;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Movement proxy — called from BloodmancerControllerComponent's state machine
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns true while the dash is in progress (mirrors GrappleSystem.isActive). */
  public isActive(): boolean {
    return this.grappleSystem.isActive();
  }

  /**
   * Drives the dash movement. Returns true while still travelling.
   * Call this every frame inside the GRAPPLING state case.
   */
  public updateMovement(dt: number): boolean {
    return this.grappleSystem.update(dt);
  }

  /** Exit velocity of the dash for momentum transfer. */
  public getVelocity(): vec3 {
    return this.grappleSystem.getGrappleVelocity();
  }

  /** Tick the recharge timer. Call every frame. */
  public tickRecharge(dt: number): void {
    this.grappleSystem.tickRecharge(dt);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ability update — input polling + target selection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called every frame from BloodmancerControllerComponent.update().
   *
   * @param dt            Delta time in seconds.
   * @param player        The player entity (used for position and trigger registry lookup).
   * @param cameraForward Horizontal-projected forward vector of the camera.
   */
  public update(dt: number, player: Entity, cameraForward: vec3): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;

    const nowActive = this.grappleSystem.isActive();

    // Detect arrival: grapple was active last frame, now it ended.
    if (this.wasActive && !nowActive && this.targetEntity) {
      this.onArrival();
    }

    this.wasActive = nowActive;

    // While dashing, skip input.
    if (nowActive) return;

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.ABILITY_E)) return;
    if (this.cooldownTimer > 0) return;

    const playerTc = player.getComponent('transform') as TransformComponent | null;
    if (!playerTc) return;
    const playerPos = playerTc.getTransform().getWorldPosition() as vec3;

    const target = this.findTarget(player.id, playerPos, cameraForward);
    if (!target) return;

    const targetTc = target.getComponent('transform') as TransformComponent | null;
    if (!targetTc) return;

    const enemyPos = targetTc.getTransform().getWorldPosition() as vec3;
    this.targetEntity = target;
    this.cooldownTimer = this.cooldown;

    this.grappleSystem.startGrapple(enemyPos, enemyPos, GrappleTargetType.PUNCTUAL);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Uses the ChargeTargetComponent trigger registry — only enemies whose
   * trigger sphere encloses the player are considered, so no full entity scan.
   */
  private findTarget(playerId: number, playerPos: vec3, cameraForward: vec3): Entity | null {
    const inRange = ChargeTargetComponent.getInRangeComponents(playerId);

    let bestDist = Infinity;
    let bestEntity: Entity | null = null;

    for (const chargeTarget of inRange) {
      const enemy = chargeTarget.getEnemyEntity();
      if (!enemy) continue;

      const health = enemy.getComponent('health') as HealthComponent | null;
      if (!health || health.isDead()) continue;
      if (health.getHpRatio() > this.hpRatioThreshold) continue;

      const tc = enemy.getComponent('transform') as TransformComponent | null;
      if (!tc) continue;

      const enemyPos = tc.getTransform().getWorldPosition() as vec3;
      const toEnemy = vec3.subtract(vec3.create(), enemyPos, playerPos);
      const dist = vec3.length(toEnemy);
      if (dist < 0.01) continue;

      // Check that the enemy is roughly in front of the camera.
      const dirToEnemy = vec3.scale(vec3.create(), toEnemy, 1 / dist);
      if (vec3.dot(dirToEnemy, cameraForward) < this.forwardDot) continue;

      if (dist < bestDist) {
        bestDist = dist;
        bestEntity = enemy;
      }
    }

    return bestEntity;
  }

  private onArrival(): void {
    const entity = this.targetEntity!;
    this.targetEntity = null;

    // Kill the enemy.
    entity.sendMsg(Msg.damage({ amount: 99999, instigator: null }));

    // Heal the player 5% of max HP.
    const health = this.getHealth();
    if (health) {
      health.heal(health.getMaxHp() * this.healPercent);
    }

    // Restore 40 blood.
    this.getBlood()?.restore(this.bloodRestore);

    console.log('[ChargeSystem] Kill charge! +5% HP, +40 blood');
  }
}
