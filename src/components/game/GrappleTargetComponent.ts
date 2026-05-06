import { vec3, mat4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import type { IMsg } from '../../core/ecs/Msg';
import type { TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';
import { GrappleTargetType } from '../../types/GrappleTargetType.enum';
import { Engine } from '../../core/engine/Engine';
import type { TransformComponent } from '../core/TransformComponent';

export const enum GrappleHookShape {
  /** Single point — uses the transform origin. */
  POINT,
  /** Bar / ledge — uses localPointA and localPointB in local space. */
  SEGMENT,
}

export interface GrappleHookData {
  /** Type of grapple point. Defaults to 'PUNCTUAL'. */
  hookType?: 'LEDGE' | 'CORNER' | 'PUNCTUAL';
  /** Shape of the hook target. Defaults to 'POINT'. */
  shape?: 'POINT' | 'SEGMENT';
  /** Local-space start of the bar segment. Only used when shape === 'SEGMENT'. */
  pointA?: [number, number, number];
  /** Local-space end of the bar segment. Only used when shape === 'SEGMENT'. */
  pointB?: [number, number, number];
}

/**
 * GrappleTargetComponent — Marks an entity as a valid grapple hook target.
 *
 * Declares the hook type (LEDGE / CORNER / PUNCTUAL) and maintains a set
 * of player entity IDs currently inside the associated sphere trigger.
 *
 * The static `inRangeOf` registry maps each player entity ID to the set of
 * hook components currently containing that player. GrappleSystem reads this
 * directly so it never needs to iterate all entities — only the relevant ones.
 */
export class GrappleTargetComponent extends Component {
  private hookType: GrappleTargetType = GrappleTargetType.PUNCTUAL;
  private shape: GrappleHookShape = GrappleHookShape.POINT;
  private localPointA: vec3 = vec3.create();
  private localPointB: vec3 = vec3.create();

  /** Static registry: playerId → set of hook components that contain that player. */
  private static readonly inRangeOf: Map<number, Set<GrappleTargetComponent>> = new Map();

  /** Returns the set of hook components currently in range of the given player. */
  public static getInRangeComponents(playerId: number): ReadonlySet<GrappleTargetComponent> {
    return GrappleTargetComponent.inRangeOf.get(playerId) ?? new Set();
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

    this.shape = data?.shape === 'SEGMENT' ? GrappleHookShape.SEGMENT : GrappleHookShape.POINT;

    if (this.shape === GrappleHookShape.SEGMENT) {
      if (data.pointA) vec3.set(this.localPointA, data.pointA[0], data.pointA[1], data.pointA[2]);
      if (data.pointB) vec3.set(this.localPointB, data.pointB[0], data.pointB[1], data.pointB[2]);
    }
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'grapple_target', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as GrappleTargetComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'grapple_target', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as GrappleTargetComponent).onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity?.hasComponent('player_controller')) {
      let set = GrappleTargetComponent.inRangeOf.get(entityId);
      if (!set) {
        set = new Set();
        GrappleTargetComponent.inRangeOf.set(entityId, set);
      }
      set.add(this);
    }
  }

  private onEntityExit(entityId: number): void {
    GrappleTargetComponent.inRangeOf.get(entityId)?.delete(this);
  }

  /** The declared hook type for this target (drives arrival behaviour). */
  public getHookType(): GrappleTargetType {
    return this.hookType;
  }

  public getShape(): GrappleHookShape {
    return this.shape;
  }

  /**
   * Devuelve el segmento en world space.
   * Si shape === POINT, devuelve a === b === posición del transform (degenerado).
   */
  public getWorldSegment(): { a: vec3; b: vec3 } {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;

    if (!transform) {
      const p = vec3.create();
      return { a: p, b: vec3.clone(p) };
    }

    if (this.shape === GrappleHookShape.POINT) {
      const p = transform.getTransform().getWorldPosition();
      return { a: vec3.clone(p), b: vec3.clone(p) };
    }

    const mat = transform.getTransform().getWorldMatrix() as mat4;
    const a = vec3.transformMat4(vec3.create(), this.localPointA, mat);
    const b = vec3.transformMat4(vec3.create(), this.localPointB, mat);
    return { a, b };
  }

  public update(_dt: number): void {}
  public renderDebug(): void {}
}
