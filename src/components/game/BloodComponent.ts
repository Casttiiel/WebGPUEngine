import { Component } from '../../core/ecs/Component';
import { BloodComponentDataType } from '../../types/BloodComponentData.type';
import { Msg } from '../../core/ecs/Msg';

/**
 * BloodComponent — Recurso de sangre del Bloodmancer.
 *
 * Se comporta como StaminaComponent con una diferencia clave: la regeneración
 * solo comienza después de un periodo de inactividad de `regenDelay` segundos
 * (por defecto 10 s) desde el último gasto, en lugar de los ~2 s de la stamina.
 *
 * Uso en JSON:
 * ```json
 * "blood": { "maxBlood": 100, "regenRate": 15, "regenDelay": 10.0 }
 * ```
 *
 * Mensajes emitidos:
 *   BLOOD_SPENT    — cada vez que se gasta sangre
 *   BLOOD_DEPLETED — cuando la sangre llega a 0
 *   BLOOD_RESTORED — cuando la sangre vuelve al máximo
 */
export class BloodComponent extends Component {
  private maxBlood: number = 100;
  private currentBlood: number = 100;
  private regenRate: number = 15;
  /** Segundos de inactividad requeridos antes de empezar a regenerar. */
  private regenDelay: number = 10.0;
  /** Cuenta regresiva: > 0 significa que la regen está bloqueada. */
  private regenDelayTimer: number = 0;

  public load(data: BloodComponentDataType): void {
    this.maxBlood = data.maxBlood ?? this.maxBlood;
    this.regenRate = data.regenRate ?? this.regenRate;
    this.regenDelay = data.regenDelay ?? this.regenDelay;
    this.currentBlood = this.maxBlood;
  }

  public update(deltaTime: number): void {
    // El timer se actualiza siempre que esté activo
    if (this.regenDelayTimer > 0) {
      this.regenDelayTimer -= deltaTime;
      return;
    }

    // Regenerar gradualmente hasta el máximo
    if (this.currentBlood < this.maxBlood) {
      this.currentBlood = Math.min(this.maxBlood, this.currentBlood + this.regenRate * deltaTime);

      if (this.currentBlood >= this.maxBlood) {
        this.getOwner().sendMsg(Msg.bloodRestored());
      }
    }
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * Intenta gastar `amount` de sangre.
   * @returns true si había suficiente sangre y se gastó; false si no.
   */
  public spend(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.currentBlood < amount) return false;

    this.currentBlood -= amount;
    // Reiniciar el timer completo con cada gasto
    this.regenDelayTimer = this.regenDelay;

    this.getOwner().sendMsg(Msg.bloodSpent({ amount, current: this.currentBlood }));

    if (this.currentBlood <= 0) {
      this.currentBlood = 0;
      this.getOwner().sendMsg(Msg.bloodDepleted());
    }

    return true;
  }

  /**
   * Igual que `spend` pero clampea a 0 en lugar de fallar.
   * Útil para costes que no deben bloquear la acción.
   */
  public spendClamped(amount: number): void {
    if (amount <= 0) return;
    const actual = Math.min(amount, this.currentBlood);
    if (actual <= 0) return;
    this.spend(actual);
  }

  /**
   * Añade `amount` de sangre directamente, sin tocar el timer de regen.
   * Útil para efectos externos (drenado de enemigos, pociones, etc.).
   */
  public restore(amount: number): void {
    if (amount <= 0) return;
    this.currentBlood = Math.min(this.maxBlood, this.currentBlood + amount);
    if (this.currentBlood >= this.maxBlood) {
      this.getOwner().sendMsg(Msg.bloodRestored());
    }
  }

  /** true si hay al menos `amount` de sangre disponible. */
  public has(amount: number): boolean {
    return this.currentBlood >= amount;
  }

  public isDepleted(): boolean {
    return this.currentBlood <= 0;
  }

  /** true si el timer de regen está activo (no ha pasado el regenDelay). */
  public isRegenBlocked(): boolean {
    return this.regenDelayTimer > 0;
  }

  /** Segundos que quedan hasta que empiece la regeneración (0 si ya está regenerando). */
  public getRegenCountdown(): number {
    return Math.max(0, this.regenDelayTimer);
  }

  public getBlood(): number {
    return this.currentBlood;
  }

  public getMaxBlood(): number {
    return this.maxBlood;
  }

  /** Ratio 0..1 (útil para barras de sangre). */
  public getBloodRatio(): number {
    return this.currentBlood / this.maxBlood;
  }

  public override dispose(): void {}
  public override renderInMenu(): void {}
  public override renderDebug(): void {}
}
