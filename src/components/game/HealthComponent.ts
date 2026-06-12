import { Component } from '../../core/ecs/Component';
import { HealthComponentDataType } from '../../types/HealthComponentData.type';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { Msg } from '../../core/ecs/Msg';
import type { IMsg, TMsgDamage } from '../../core/ecs/Msg';

/**
 * HealthComponent — Componente genérico de vida.
 *
 * Usable por jugadores y enemigos. No contiene lógica de UI ni de física.
 *
 * Entrada de daño:
 * ```ts
 * entity.sendMsg(Msg.damage({ amount: 25, instigator: attackerEntity }));
 * ```
 *
 * Suscripción a eventos de salud:
 * ```ts
 * // En el static registerMsgs() de otro componente:
 * MsgDispatcher.register(MsgType.ON_DAMAGED, 'my_comp', (comp, msg) => { ... });
 * MsgDispatcher.register(MsgType.ON_DEATH,   'my_comp', (comp, msg) => { ... });
 * ```
 */
export class HealthComponent extends Component {
  private maxHp: number = 100;
  private currentHp: number = 100;
  private invincibilityTime: number = 0;
  private invincibilityTimer: number = 0;
  /** Fraction of incoming damage absorbed (0..1). Bypassed by 'bypass_resistance' sourceTag. */
  private damageResistance: number = 0;
  /**
   * Faction tag set via prefab. Damage from an instigator with the same faction is rejected.
   * Null = no faction = receives damage from everyone (training dummy, neutral objects).
   */
  private faction: string | null = null;
  /**
   * Optional hook called before damage is applied.
   * Return true to cancel the damage (e.g. parry).
   */
  private damageInterceptor:
    | ((amount: number, instigator: import('../../core/ecs/Entity').Entity | null) => boolean)
    | null = null;

  public load(data: HealthComponentDataType): void {
    this.maxHp = data.maxHp ?? this.maxHp;
    this.invincibilityTime = data.invincibilityTime ?? this.invincibilityTime;
    this.damageResistance = data.damageResistance ?? 0;
    this.faction = data.faction ?? null;
    this.currentHp = this.maxHp;
  }

  public update(deltaTime: number): void {
    if (this.invincibilityTimer > 0) {
      this.invincibilityTimer -= deltaTime;
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  public takeDamage(
    amount: number,
    instigator: import('../../core/ecs/Entity').Entity | null = null,
    sourceTag?: string,
  ): void {
    if (amount <= 0) return;
    if (this.isDead()) return;
    if (this.invincibilityTimer > 0) return;

    // Friendly-fire prevention: reject damage from instigators with the same faction.
    if (this.faction !== null && instigator !== null) {
      const instigatorHealth = instigator.getComponent('health') as HealthComponent | null;
      if (instigatorHealth?.faction === this.faction) return;
    }

    // Parry / damage interceptor — runs before resistance and HP reduction.
    if (this.damageInterceptor?.(amount, instigator)) return;

    // Apply resistance unless the source explicitly bypasses it
    const effective =
      this.damageResistance > 0 && sourceTag !== 'bypass_resistance'
        ? amount * (1 - this.damageResistance)
        : amount;

    const actual = Math.min(effective, this.currentHp);
    this.currentHp -= actual;
    this.invincibilityTimer = this.invincibilityTime;
    console.log(`[Health] ${this.getOwner().getName()} HP: ${this.currentHp} / ${this.maxHp}`);

    this.getOwner().sendMsg(
      Msg.onDamaged({ amount: actual, currentHp: this.currentHp, instigator }),
    );

    if (this.currentHp <= 0) {
      this.getOwner().sendMsg(Msg.onDeath({ instigator }));
    }
  }

  public heal(amount: number): void {
    if (amount <= 0) return;
    if (this.isDead()) return;

    const actual = Math.min(amount, this.maxHp - this.currentHp);
    if (actual <= 0) return;

    this.currentHp += actual;
    this.getOwner().sendMsg(Msg.onHealed({ amount: actual, currentHp: this.currentHp }));
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

  /**
   * Sets an optional damage interceptor.
   * The callback receives the raw damage amount and instigator; return true to cancel the hit.
   * Pass null to remove the interceptor.
   */
  public setDamageInterceptor(
    fn:
      | ((amount: number, instigator: import('../../core/ecs/Entity').Entity | null) => boolean)
      | null,
  ): void {
    this.damageInterceptor = fn;
  }

  public override dispose(): void {}

  public override renderInMenu(): void {}
  public override renderDebug(): void {}

  /**
   * Suscribe HealthComponent a los mensajes que le interesan.
   * Llamar una vez al arranque del motor desde Engine.registerAllMsgs().
   */
  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.DAMAGE, 'health', (comp, msg) => {
      const payload = (msg as IMsg<TMsgDamage>).payload;
      (comp as HealthComponent).takeDamage(payload.amount, payload.instigator, payload.sourceTag);
    });
  }
}
