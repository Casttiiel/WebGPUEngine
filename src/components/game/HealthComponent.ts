import { Component } from '../../core/ecs/Component';
import { HealthComponentDataType } from '../../types/HealthComponentData.type';

/**
 * HealthComponent — Componente genérico de vida.
 *
 * Usable por jugadores y enemigos. No contiene lógica de UI ni de física;
 * solo gestiona el estado de vida y dispara callbacks registrados.
 *
 * Uso en JSON:
 * ```json
 * "health": { "maxHp": 100, "invincibilityTime": 0.3 }
 * ```
 *
 * Callbacks:
 * ```ts
 * const hp = entity.getComponent('health') as HealthComponent;
 * hp.onDamaged.push((amount, current) => { ... });
 * hp.onDeath.push(() => { ... });
 * hp.onHealed.push((amount, current) => { ... });
 * ```
 */
export class HealthComponent extends Component {
  private maxHp: number = 100;
  private currentHp: number = 100;
  private invincibilityTime: number = 0;
  private invincibilityTimer: number = 0;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  public onDamaged: Array<(amount: number, current: number) => void> = [];
  public onDeath: Array<() => void> = [];
  public onHealed: Array<(amount: number, current: number) => void> = [];

  public load(data: HealthComponentDataType): void {
    this.maxHp = data.maxHp ?? this.maxHp;
    this.invincibilityTime = data.invincibilityTime ?? this.invincibilityTime;
    this.currentHp = this.maxHp;
  }

  public update(deltaTime: number): void {
    if (this.invincibilityTimer > 0) {
      this.invincibilityTimer -= deltaTime;
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  public takeDamage(amount: number): void {
    if (amount <= 0) return;
    if (this.isDead()) return;
    if (this.invincibilityTimer > 0) return;

    const actual = Math.min(amount, this.currentHp);
    this.currentHp -= actual;

    this.invincibilityTimer = this.invincibilityTime;

    for (const cb of this.onDamaged) cb(actual, this.currentHp);

    if (this.currentHp <= 0) {
      for (const cb of this.onDeath) cb();
    }
  }

  public heal(amount: number): void {
    if (amount <= 0) return;
    if (this.isDead()) return;

    const actual = Math.min(amount, this.maxHp - this.currentHp);
    if (actual <= 0) return;

    this.currentHp += actual;
    for (const cb of this.onHealed) cb(actual, this.currentHp);
  }

  public isDead(): boolean {
    return this.currentHp <= 0;
  }

  public getHp(): number {
    return this.currentHp;
  }

  public getMaxHp(): number {
    return this.maxHp;
  }

  /** Ratio 0..1 (útil para barras de vida). */
  public getHpRatio(): number {
    return this.currentHp / this.maxHp;
  }

  public isInvincible(): boolean {
    return this.invincibilityTimer > 0;
  }

  public override dispose(): void {
    this.onDamaged.length = 0;
    this.onDeath.length = 0;
    this.onHealed.length = 0;
  }

  public override renderInMenu(): void {}
}
