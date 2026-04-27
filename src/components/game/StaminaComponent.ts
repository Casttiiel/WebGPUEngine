import { Component } from '../../core/ecs/Component';
import { StaminaComponentDataType } from '../../types/StaminaComponentData.type';

/**
 * StaminaComponent — Componente de stamina para el jugador.
 *
 * Gestiona el gasto y regeneración de stamina. No contiene lógica de UI;
 * usa callbacks para notificar cambios.
 *
 * Uso en JSON:
 * ```json
 * "stamina": { "maxStamina": 100, "regenRate": 20, "regenDelay": 1.0 }
 * ```
 *
 * Callbacks:
 * ```ts
 * const st = entity.getComponent('stamina') as StaminaComponent;
 * st.onSpent.push((amount, current) => { ... });
 * st.onDepleted.push(() => { ... });    // llega a 0
 * st.onFullyRestored.push(() => { ... }); // vuelve al máximo
 * ```
 */
export class StaminaComponent extends Component {
  private maxStamina: number = 100;
  private currentStamina: number = 100;
  private regenRate: number = 20;
  private regenDelay: number = 2.0;
  private regenDelayTimer: number = 0;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  public onSpent: Array<(amount: number, current: number) => void> = [];
  public onDepleted: Array<() => void> = [];
  public onFullyRestored: Array<() => void> = [];

  public load(data: StaminaComponentDataType): void {
    this.maxStamina = data.maxStamina ?? this.maxStamina;
    this.regenRate = data.regenRate ?? this.regenRate;
    this.regenDelay = data.regenDelay ?? this.regenDelay;
    this.currentStamina = this.maxStamina;
  }

  public update(deltaTime: number): void {
    // Countdown del delay de regen
    if (this.regenDelayTimer > 0) {
      this.regenDelayTimer -= deltaTime;
      return;
    }

    // Regenerar si no está llena
    if (this.currentStamina < this.maxStamina) {
      const wasEmpty = this.currentStamina <= 0;
      this.currentStamina = Math.min(
        this.maxStamina,
        this.currentStamina + this.regenRate * deltaTime,
      );

      if (wasEmpty && this.currentStamina > 0) {
        // Salió de agotamiento — no notificamos onFullyRestored aún
      }
      if (this.currentStamina >= this.maxStamina) {
        for (const cb of this.onFullyRestored) cb();
      }
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  /**
   * Intenta gastar `amount` de stamina.
   * @returns true si había suficiente stamina y se gastó; false si no.
   */
  public spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.currentStamina < amount) return false;

    const wasFull = this.currentStamina >= this.maxStamina;
    this.currentStamina -= amount;
    this.regenDelayTimer = this.regenDelay;

    for (const cb of this.onSpent) cb(amount, this.currentStamina);

    if (this.currentStamina <= 0) {
      this.currentStamina = 0;
      for (const cb of this.onDepleted) cb();
    }

    return true;
  }

  /**
   * Igual que `spend` pero no falla si no hay stamina suficiente —
   * simplemente la clampea a 0. Útil para costes que no deben bloquearse.
   */
  public spendClamped(amount: number): void {
    if (amount <= 0) return;
    const actual = Math.min(amount, this.currentStamina);
    if (actual <= 0) return;
    this.spend(actual);
  }

  /** true si hay al menos `amount` de stamina disponible. */
  public has(amount: number): boolean {
    return this.currentStamina >= amount;
  }

  public isDepleted(): boolean {
    return this.currentStamina <= 0;
  }

  public getStamina(): number {
    return this.currentStamina;
  }

  public getMaxStamina(): number {
    return this.maxStamina;
  }

  /** Ratio 0..1 (útil para barras de stamina). */
  public getStaminaRatio(): number {
    return this.currentStamina / this.maxStamina;
  }

  public override dispose(): void {
    this.onSpent.length = 0;
    this.onDepleted.length = 0;
    this.onFullyRestored.length = 0;
  }

  public override renderInMenu(): void {}

  public override renderDebug(): void {}
}
