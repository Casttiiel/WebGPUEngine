import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { IMsg } from '../../core/ecs/Msg';
import { TMsgOnDamaged } from '../../core/ecs/Msg';
import { AnimatorComponent } from '../render/AnimatorComponent';
import { TransformComponent } from '../core/TransformComponent';

export interface HitReactionData {
  weight?: number;
  blendIn?: number;
  cooldown?: number;
}

/**
 * HitReactionComponent — Generic directional hit-reaction animation layer.
 *
 * Picks one of five clips based on where the instigator is relative to the
 * target's body:
 *   - Hit_head        (attacker above)
 *   - Hit_Stomach     (attacker below)
 *   - Hit_shoulder_R  (attacker to target's right)
 *   - Hit_shoulder_L  (attacker to target's left)
 *   - Hit_chest       (default / center)
 *
 * Attach to any entity with HealthComponent + AnimatorComponent (or a child
 * with one). Works identically for player and enemies.
 *
 * Component key: 'hit_reaction'
 */
export class HitReactionComponent extends Component {
  private weight: number = 0.8;
  private blendIn: number = 0.05;
  private cooldown: number = 0.3;

  private cooldownTimer: number = 0;
  private animator: AnimatorComponent | null = null;
  private animatorFound: boolean = false;

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DAMAGED, 'hit_reaction', (comp, msg) => {
      (comp as HitReactionComponent).onDamaged(msg as IMsg<TMsgOnDamaged>);
    });
  }

  public load(data: HitReactionData): void {
    this.weight = data?.weight ?? this.weight;
    this.blendIn = data?.blendIn ?? this.blendIn;
    this.cooldown = data?.cooldown ?? this.cooldown;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.findAnimator();
  }

  private onDamaged(msg: IMsg<TMsgOnDamaged>): void {
    if (this.cooldownTimer > 0) return;
    this.findAnimator();

    const clip = this.pickClip(msg.payload.instigator);
    this.animator?.addLayer(clip, { loop: false, weight: this.weight, blendInTime: this.blendIn });
    this.cooldownTimer = this.cooldown;
  }

  private pickClip(instigator: import('../../core/ecs/Entity').Entity | null): string {
    if (!instigator) return 'Hit_chest';

    const myTc = this.getOwner().getComponent('transform') as TransformComponent | null;
    const attackerTc = instigator.getComponent('transform') as TransformComponent | null;
    if (!myTc || !attackerTc) return 'Hit_chest';

    const myPos = myTc.getTransform().getWorldPosition() as vec3;
    const attackerPos = attackerTc.getTransform().getWorldPosition() as vec3;

    // Direction from me to attacker (tells us which side of my body was exposed)
    const toAttacker = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), attackerPos, myPos));

    const myRight = myTc.getTransform().getRight();
    const myUp = myTc.getTransform().getUp();

    const upDot = vec3.dot(toAttacker, myUp);
    const rightDot = vec3.dot(toAttacker, myRight);

    if (upDot > 0.5)        return 'Hit_head';
    if (upDot < -0.3)       return 'Hit_Stomach';
    if (rightDot > 0.35)    return 'Hit_shoulder_R';
    if (rightDot < -0.35)   return 'Hit_shoulder_L';
    return 'Hit_chest';
  }

  private findAnimator(): void {
    if (this.animatorFound) return;
    const selfAnim = this.getOwner().getComponent('animator') as AnimatorComponent | null;
    if (selfAnim) {
      this.animator = selfAnim;
      this.animatorFound = true;
      return;
    }
    for (const child of this.getOwner().getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) { this.animator = anim; break; }
    }
    this.animatorFound = true;
  }

  public renderDebug(): void {}
}
