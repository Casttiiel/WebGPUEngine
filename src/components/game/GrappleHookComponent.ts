import { Component } from '../../core/ecs/Component';

/**
 * GrappleHookComponent — Marker component.
 * Any entity that has this component is a valid grapple target.
 * When a dagger projectile hits it, the player gets pulled toward the hit point.
 */
export class GrappleHookComponent extends Component {
  public load(_data: Record<string, never>): void {}
  public update(_dt: number): void {}
  public renderDebug(): void {}
}
