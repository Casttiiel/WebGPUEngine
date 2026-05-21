import { Component } from '../../../core/ecs/Component';
import { MsgDispatcher } from '../../../core/ecs/MsgDispatcher';
import { Msg, TMsgDamage } from '../../../core/ecs/Msg';
import { MsgType } from '../../../types/MsgType.enum';
import type { IMsg } from '../../../core/ecs/Msg';

export type WeakPointComponentData = {
  /**
   * Damage multiplier applied to incoming hits.
   * Default: 5 — a full hit bypasses resistance and deals 5× damage to the parent.
   */
  damageMultiplier?: number;
  /**
   * If set, only hits whose `sourceTag` matches this value are amplified.
   * Leave undefined to amplify ALL incoming damage.
   * Example: 'blood_explosive' to only reward explosive projectiles.
   */
  projectileTag?: string;
};

/**
 * WeakPointComponent — Attached to a CHILD entity of an enemy.
 *
 * When the child entity is hit by a DAMAGE message (e.g. a projectile hits
 * the child's collider), it:
 *   1. Multiplies the incoming damage by `damageMultiplier`.
 *   2. Forwards the result to the PARENT entity with `sourceTag: 'bypass_resistance'`
 *      so damageResistance in HealthComponent is ignored.
 *
 * This enables tanky enemies (Enemy E) to have a vulnerability window by
 * exposing this child during a specific animation state.
 *
 * Component key: 'weak_point'
 */
export class WeakPointComponent extends Component {
  private damageMultiplier: number = 5.0;
  private projectileTag: string | undefined = undefined;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public load(data: WeakPointComponentData): void {
    this.damageMultiplier = data?.damageMultiplier ?? this.damageMultiplier;
    this.projectileTag = data?.projectileTag;
  }

  public update(_dt: number): void {}

  public dispose(): void {}

  // ── Message handling ──────────────────────────────────────────────────────

  public onDamage(msg: IMsg<TMsgDamage>): void {
    const { amount, instigator, sourceTag } = msg.payload;

    // If a projectileTag filter is configured, only react to matching hits
    if (this.projectileTag !== undefined && sourceTag !== this.projectileTag) {
      return;
    }

    const parent = this.getOwner().getParent();
    if (!parent) return;

    parent.sendMsg(
      Msg.damage({
        amount: amount * this.damageMultiplier,
        instigator,
        sourceTag: 'bypass_resistance',
      }),
    );
  }

  // ── Global registration ───────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.DAMAGE, 'weak_point', (comp, msg) => {
      (comp as WeakPointComponent).onDamage(msg as IMsg<TMsgDamage>);
    });
  }
}
