import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { Engine } from '../../core/engine/Engine';
import type { IMsg } from '../../core/ecs/Msg';
import type { TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';
import type { Entity } from '../../core/ecs/Entity';
import type { TransformComponent } from '../core/TransformComponent';
import type { SphereColliderComponent } from '../physics/SphereColliderComponent';

/**
 * ChargeTargetComponent — Marks an enemy entity (via a child) as a valid charge target.
 *
 * Attach to a child entity that also has a sphere_collider (kinematic, isSensor:true).
 * The sphere trigger detects when the player enters range.
 *
 * In update(), the sphere collider is repositioned each frame to follow the parent enemy.
 *
 * ChargeSystem reads the static `inRangeOf` registry to find all enemies
 * currently in range of the player without iterating every entity.
 */
export class ChargeTargetComponent extends Component {
  /** Static registry: playerId → set of ChargeTargetComponents whose sphere encloses that player. */
  private static readonly inRangeOf: Map<number, Set<ChargeTargetComponent>> = new Map();

  /** Returns all charge targets currently in range of the given player entity. */
  public static getInRangeComponents(playerId: number): ReadonlySet<ChargeTargetComponent> {
    return ChargeTargetComponent.inRangeOf.get(playerId) ?? new Set();
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'charge_target', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as ChargeTargetComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'charge_target', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as ChargeTargetComponent).onEntityExit(otherEntityId);
    });
  }

  /**
   * Returns the actual enemy entity (the parent of the trigger child entity).
   */
  public getEnemyEntity(): Entity | null {
    return this.getOwner().getParent();
  }

  public load(_data: unknown): void {}

  /**
   * Syncs the sphere sensor position to the parent enemy's world position each frame,
   * so the trigger follows the enemy as it moves.
   */
  public update(_dt: number): void {
    const parent = this.getOwner().getParent();
    if (!parent) return;

    const enemyTc = parent.getComponent('transform') as TransformComponent | null;
    if (!enemyTc) return;

    const pos = enemyTc.getTransform().getWorldPosition();

    const sphereComp = this.getOwner().getComponent(
      'sphere_collider',
    ) as SphereColliderComponent | null;
    if (!sphereComp) return;

    sphereComp.getRigidBody().setNextKinematicTranslation({ x: pos[0], y: pos[1], z: pos[2] });
  }

  public renderDebug(): void {}

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity?.hasComponent('player_controller')) {
      let set = ChargeTargetComponent.inRangeOf.get(entityId);
      if (!set) {
        set = new Set();
        ChargeTargetComponent.inRangeOf.set(entityId, set);
      }
      set.add(this);
    }
  }

  private onEntityExit(entityId: number): void {
    ChargeTargetComponent.inRangeOf.get(entityId)?.delete(this);
  }
}
