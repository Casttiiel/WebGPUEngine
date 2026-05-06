import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import type { IMsg } from '../../core/ecs/Msg';
import type { TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';
import { GrappleTargetType } from '../../types/GrappleTargetType.enum';
import { Engine } from '../../core/engine/Engine';

export interface GrappleHookData {
  /** Type of grapple point. Defaults to 'PUNCTUAL'. */
  hookType?: 'LEDGE' | 'CORNER' | 'PUNCTUAL';
}

/**
 * GrappleHookComponent — Marks an entity as a valid grapple hook target.
 *
 * Declares the hook type (LEDGE / CORNER / PUNCTUAL) and maintains a set
 * of player entity IDs currently inside the associated sphere trigger.
 *
 * The static `inRangeOf` registry maps each player entity ID to the set of
 * hook components currently containing that player. GrappleSystem reads this
 * directly so it never needs to iterate all entities — only the relevant ones.
 */
export class GrappleHookComponent extends Component {
  private hookType: GrappleTargetType = GrappleTargetType.PUNCTUAL;

  /** Static registry: playerId → set of hook components that contain that player. */
  private static readonly inRangeOf: Map<number, Set<GrappleHookComponent>> = new Map();

  /** Returns the set of hook components currently in range of the given player. */
  public static getInRangeComponents(playerId: number): ReadonlySet<GrappleHookComponent> {
    return GrappleHookComponent.inRangeOf.get(playerId) ?? new Set();
  }

  public load(data: GrappleHookData): void {
    switch (data?.hookType) {
      case 'LEDGE':
        this.hookType = GrappleTargetType.LEDGE;
        break;
      case 'CORNER':
        this.hookType = GrappleTargetType.CORNER;
        break;
      default:
        this.hookType = GrappleTargetType.PUNCTUAL;
    }
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'grapple_hook', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as GrappleHookComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'grapple_hook', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as GrappleHookComponent).onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity?.hasComponent('player_controller')) {
      let set = GrappleHookComponent.inRangeOf.get(entityId);
      if (!set) {
        set = new Set();
        GrappleHookComponent.inRangeOf.set(entityId, set);
      }
      set.add(this);
    }
  }

  private onEntityExit(entityId: number): void {
    GrappleHookComponent.inRangeOf.get(entityId)?.delete(this);
  }

  /** The declared hook type for this target (drives arrival behaviour). */
  public getHookType(): GrappleTargetType {
    return this.hookType;
  }

  public update(_dt: number): void {}
  public renderDebug(): void {}
}
