import { vec3 } from 'gl-matrix';
import type { Entity } from '../../../core/ecs/Entity';
import { EnemyControllerComponent } from '../EnemyControllerComponent';

export interface ParrySystemData {
  /** How long (seconds) the parry window stays open after pressing the button. Default: 0.2 */
  windowDuration?: number;
  /** Cooldown (seconds) before the player can parry again. Default: 0.5 */
  cooldown?: number;
  /** How long (seconds) the attacker is stunned on a successful parry. Default: 2.0 */
  stunDuration?: number;
}

/**
 * ParrySystem — Self-contained parry mechanic.
 *
 * Usage:
 *  1. Call tryOpenWindow() when the player presses the parry button.
 *  2. Call update(dt) every frame.
 *  3. Wire tryConsume() into HealthComponent's damageInterceptor so that incoming
 *     damage is blocked when the window is open.
 */
export class ParrySystem {
  private readonly windowDuration: number;
  private readonly cooldown: number;
  private readonly stunDuration: number;

  private windowTimer: number = 0;
  private cooldownTimer: number = 0;

  constructor(data: ParrySystemData = {}) {
    this.windowDuration = data.windowDuration ?? 0.2;
    this.cooldown = data.cooldown ?? 0.5;
    this.stunDuration = data.stunDuration ?? 2.0;
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────────

  public update(dt: number): void {
    if (this.windowTimer > 0) this.windowTimer -= dt;
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
  }

  // ── State queries ──────────────────────────────────────────────────────────

  public isWindowOpen(): boolean {
    return this.windowTimer > 0;
  }

  public isOnCooldown(): boolean {
    return this.cooldownTimer > 0;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Attempts to open the parry window.
   * Fails silently if on cooldown or if the window is already open.
   * Returns true if the window was opened.
   */
  public tryOpenWindow(): boolean {
    if (this.cooldownTimer > 0 || this.windowTimer > 0) return false;
    this.windowTimer = this.windowDuration;
    return true;
  }

  /** Starts the cooldown without opening a window (e.g. after an AoE parry). */
  public startCooldown(): void {
    this.windowTimer = 0;
    this.cooldownTimer = this.cooldown;
  }

  /**
   * Called by HealthComponent's damageInterceptor when the player receives damage.
   * Returns true if the hit was parried (damage should be cancelled).
   * On success: closes the window, starts cooldown, and stuns the attacker.
   */
  public tryConsume(instigator: Entity | null): boolean {
    if (this.windowTimer <= 0) return false;

    // Parry success.
    this.windowTimer = 0;
    this.cooldownTimer = this.cooldown;

    if (instigator) {
      const enemyCtrl = instigator.getComponent(
        'enemy_controller',
      ) as EnemyControllerComponent | null;
      if (enemyCtrl) {
        // applyKnockback with zero impulse suppresses enemy BT movement for stunDuration seconds.
        enemyCtrl.applyKnockback(vec3.create(), this.stunDuration);
      }
    }

    return true;
  }
}
