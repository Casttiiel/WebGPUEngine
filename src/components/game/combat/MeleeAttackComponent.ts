import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { Msg } from '../../../core/ecs/Msg';

export type MeleeAttackData = {
  /** Distance in metres at which the attack can trigger. Default: 1.8 */
  attackRange?: number;
  /** Damage dealt per hit. Default: 30 */
  damage?: number;
  /**
   * If > 0, damages ALL entities (enemies + player) within this radius.
   * If 0, only damages the single target within attackRange. Default: 0
   */
  aoeRadius?: number;
  /** Seconds between consecutive attacks. Default: 1.0 */
  cooldown?: number;
  /**
   * Seconds the owning enemy is locked out of movement after swinging.
   * Readable via isInRecovery(). Default: 0
   */
  recoveryTime?: number;
};

/**
 * MeleeAttackComponent — Reusable close-range melee with optional AoE.
 *
 * Attach to an enemy entity. Call canAttack() + attack() from the owning
 * controller's Behavior Tree (or inline Action nodes).
 *
 * Component key: 'melee_attack'
 */
export class MeleeAttackComponent extends Component {
  private attackRange: number = 1.8;
  private damage: number = 30;
  private aoeRadius: number = 0;
  private cooldown: number = 1.0;
  private recoveryTime: number = 0;

  private cooldownTimer: number = 0;
  private recoveryTimer: number = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public load(data: MeleeAttackData): void {
    this.attackRange = data?.attackRange ?? this.attackRange;
    this.damage = data?.damage ?? this.damage;
    this.aoeRadius = data?.aoeRadius ?? this.aoeRadius;
    this.cooldown = data?.cooldown ?? this.cooldown;
    this.recoveryTime = data?.recoveryTime ?? this.recoveryTime;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    if (this.recoveryTimer > 0) this.recoveryTimer -= dt;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns true if the attack is off cooldown and the player is within
   * `attackRange` of `selfPos`.
   */
  public canAttack(playerPos: vec3, selfPos: vec3): boolean {
    if (this.cooldownTimer > 0) return false;
    const dx = playerPos[0] - selfPos[0];
    const dz = playerPos[2] - selfPos[2];
    return Math.sqrt(dx * dx + dz * dz) <= this.attackRange;
  }

  /**
   * Execute the melee attack centred at `center`.
   * - If aoeRadius > 0: damages all entities with 'health' within that radius.
   * - Otherwise: damages a single entity within attackRange closest to center.
   *
   * Starts the cooldown and recovery timers.
   */
  public attack(center: vec3): void {
    if (this.aoeRadius > 0) {
      this.applyAoE(center);
    } else {
      this.applySingleTarget(center);
    }

    this.cooldownTimer = this.cooldown;
    this.recoveryTimer = this.recoveryTime;
  }

  /** True while the post-swing recovery window is active. */
  public isInRecovery(): boolean {
    return this.recoveryTimer > 0;
  }

  public getAttackRange(): number {
    return this.attackRange;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private applyAoE(center: vec3): void {
    for (const entity of Engine.getEntities().getAllEntities()) {
      if (!entity.getComponent('health')) continue;
      if (entity === this.getOwner()) continue;

      const tc = entity.getComponent('transform') as TransformComponent | null;
      if (!tc) continue;

      const pos = tc.getTransform().getWorldPosition() as vec3;
      if (vec3.distance(center, pos) > this.aoeRadius) continue;

      entity.sendMsg(Msg.damage({ amount: this.damage, instigator: this.getOwner() }));
    }
  }

  private applySingleTarget(center: vec3): void {
    let nearest: { dist: number; entityId: number } | null = null;

    for (const entity of Engine.getEntities().getAllEntities()) {
      if (!entity.getComponent('health')) continue;
      if (entity === this.getOwner()) continue;

      const tc = entity.getComponent('transform') as TransformComponent | null;
      if (!tc) continue;

      const pos = tc.getTransform().getWorldPosition() as vec3;
      const dist = vec3.distance(center, pos);
      if (dist > this.attackRange) continue;

      if (!nearest || dist < nearest.dist) {
        nearest = { dist, entityId: entity.id };
      }
    }

    if (nearest) {
      const entity = Engine.getEntities().getEntityById(nearest.entityId);
      entity?.sendMsg(Msg.damage({ amount: this.damage, instigator: this.getOwner() }));
    }
  }

  public renderDebug(): void {}
}
