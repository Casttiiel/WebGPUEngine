import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { Msg } from '../../../core/ecs/Msg';

export interface PlayerAttackData {
  damage?: number;
  range?: number;
  cooldown?: number;
  attackClip?: string;
}

export class PlayerAttackComponent extends Component {
  private damage: number = 20;
  private range: number = 1.8;
  private cooldown: number = 0.5;
  private attackClip: string = 'Sword_Attack_Standing';

  private cooldownTimer: number = 0;
  private animator: AnimatorComponent | null = null;
  private animatorFound: boolean = false;

  public load(data: PlayerAttackData): void {
    this.damage = data?.damage ?? this.damage;
    this.range = data?.range ?? this.range;
    this.cooldown = data?.cooldown ?? this.cooldown;
    this.attackClip = data?.attackClip ?? this.attackClip;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.findAnimator();

    if (Engine.getInput().isActionJustPressed(GameAction.LIGHT_ATTACK) && this.cooldownTimer <= 0) {
      this.performAttack();
    }
  }

  private performAttack(): void {
    const tc = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!tc) return;

    const ownerPos = tc.getTransform().getWorldPosition() as vec3;
    const forward = tc.getTransform().getFront();

    // Sphere centered in front of the player at chest height
    const center = vec3.scaleAndAdd(vec3.create(), ownerPos, forward, this.range * 0.5);
    center[1] += 0.8;

    this.animator?.addLayer(this.attackClip, { loop: false, weight: 1.0, blendInTime: 0.05 });

    const ownerEntity = this.getOwner();
    Engine.getPhysics().overlapSphere(center, this.range, (entityId) => {
      const entity = Engine.getEntities().getEntityById(entityId);
      if (!entity || entity === ownerEntity) return true;

      if (entity.getComponent('health')) {
        entity.sendMsg(Msg.damage({ amount: this.damage, instigator: ownerEntity }));
      }
      return true;
    });

    this.cooldownTimer = this.cooldown;
  }

  private findAnimator(): void {
    if (this.animatorFound) return;
    for (const child of this.getOwner().getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) { this.animator = anim; break; }
    }
    this.animatorFound = true;
  }

  public renderDebug(): void {}
}
