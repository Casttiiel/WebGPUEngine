import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import type { ColliderComponent } from '../physics/ColliderComponent';
import type { IKickable } from './combat/IKickable';

/** Keys to search for a collider on the same entity (priority order). */
const COLLIDER_KEYS = ['capsule_collider', 'box_collider', 'sphere_collider'] as const;

/**
 * KickableComponent — Makes a **dynamic** rigid-body entity respond to player kicks.
 *
 * Implements IKickable by calling setLinvel() once; the physics engine then integrates
 * the resulting motion with gravity and friction, producing a natural arc automatically.
 *
 * For **kinematic** (KCC-driven) entities, implement IKickable directly in the
 * controller component using KCCMovement.applyImpulse() instead.
 *
 * JSON usage:
 * ```json
 * "kickable": {}
 * ```
 */
export class KickableComponent extends Component implements IKickable {
  private rigidBody: RAPIER.RigidBody | null = null;

  public async load(_data?: unknown): Promise<void> {}

  public override async onAttach(): Promise<void> {
    for (const key of COLLIDER_KEYS) {
      const collider = this.getOwner().getComponent(key) as ColliderComponent | null;
      if (collider) {
        this.rigidBody = collider.getRigidBody();
        return;
      }
    }
    console.warn(`KickableComponent on '${this.getOwner().getName()}': no collider found.`);
  }

  public applyKnockback(impulse: vec3): void {
    if (!this.rigidBody) return;
    this.rigidBody.setLinvel({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }

  public update(_dt: number): void {}
  public renderDebug(): void {}

  public override dispose(): void {
    this.rigidBody = null;
  }
}
