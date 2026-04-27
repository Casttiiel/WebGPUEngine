import { Component } from '../../core/ecs/Component';
import { StaminaComponentDataType } from '../../types/StaminaComponentData.type';
import { Msg } from '../../core/ecs/Msg';

/**
 * StaminaComponent — Componente de stamina para el jugador.
 *
 * Gestiona el gasto y regeneración de stamina. Emite mensajes ECS para
 * notificar cambios a otros componentes interesados.
 *
 * Uso en JSON:
 * ```json
 * "stamina": { "maxStamina": 100, "regenRate": 20, "regenDelay": 1.0 }
 * ```
 *
 * Mensajes emitidos:
 *   STAMINA_SPENT    — cada vez que se gasta stamina
 *   STAMINA_DEPLETED — cuando la stamina llega a 0
 *   STAMINA_RESTORED — cuando la stamina vuelve al máximo
 */
export class StaminaComponent extends Component {
  private maxStamina: number = 100;
  private currentStamina: number = 100;
  private regenRate: number = 20;
  private regenDelay: number = 2.0;
  private regenDelayTimer: number = 0;

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
        this.getOwner().sendMsg(Msg.staminaRestored());
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

    this.currentStamina -= amount;
    this.regenDelayTimer = this.regenDelay;

    this.getOwner().sendMsg(Msg.staminaSpent({ amount, current: this.currentStamina }));

    if (this.currentStamina <= 0) {
      this.currentStamina = 0;
      this.getOwner().sendMsg(Msg.staminaDepleted());
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

  public override dispose(): void {}

  public override renderInMenu(): void {}

  public override renderDebug(): void {}
}
