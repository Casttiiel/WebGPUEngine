import { Component } from '../../core/ecs/Component';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { BasePlayerController } from './BasePlayerController';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import type { IMsg } from '../../core/ecs/Msg';
import type { TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';

export class ImpulsePadComponent extends Component {
  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();
  private force: number = 1.0;

  constructor() {
    super();
  }

  public load(data: unknown): void {
    this.force = (data as { force?: number }).force ?? 1.0;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'impulse_pad', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as ImpulsePadComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'impulse_pad', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as ImpulsePadComponent).onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('player_controller')) {
      this.entitiesInside.add(entityId);
      (entity.getComponent('player_controller') as BasePlayerController)?.applyImpulseFromPad(
        vec3.scale(vec3.create(), this.getUp(), this.force),
      );
    }
  }

  private onEntityExit(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('player_controller')) {
      this.entitiesInside.delete(entityId);
    }
  }

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}

  private getUp(): vec3 {
    const transform = this.getOwner().getComponent('transform');
    if (!transform) {
      return vec3.create();
    }
    return (transform as TransformComponent).getTransform().getUp();
  }

  public getEntitiesInside(): Set<number> {
    return this.entitiesInside;
  }
}
