import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import type { ColliderComponent } from '../physics/ColliderComponent';
import { KCCMovement } from './movement/KCCMovement';

/** Keys to search for a collider on the same entity (priority order). */
const COLLIDER_KEYS = ['capsule_collider', 'box_collider', 'sphere_collider'] as const;

/**
 * KickableComponent — Uniform IKickable entry point for the KickSystem.
 *
 * - **Dynamic** rigid body: applies knockback via setLinvel(). Physics integrates
 *   the resulting motion with gravity and friction automatically.
 * - **Kinematic** (KCC-driven) rigid body: delegates to the entity’s movement
 *   controller, which routes the impulse through KCCMovement.applyImpulse().
 *
 * JSON usage:
 * ```json
 * "kickable": {}
 * ```
 */
export class KickableComponent extends Component {
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

  public applyKnockback(impulse: vec3, _duration?: number): void {
    if (!this.rigidBody) return;

    if (this.rigidBody.bodyType() === RAPIER.RigidBodyType.Dynamic) {
      // Dynamic body: direct physics impulse — engine handles gravity and friction.
      this.rigidBody.setLinvel({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
    } else {
      // Kinematic (KCC-driven): apply the impulse directly to the movement component.
      const kcc = this.getOwner().getComponent('kcc_movement') as KCCMovement | null;
      kcc?.applyImpulse(impulse);
    }
  }

  public isStunned(): boolean {
    // Delegate to EnemyControllerComponent if present.
    const ctrl = this.getOwner().getComponent('enemy_controller') as {
      isStunned(): boolean;
    } | null;
    return ctrl?.isStunned() ?? false;
  }

  public update(_dt: number): void {}
  public renderDebug(): void {}

  public override dispose(): void {
    this.rigidBody = null;
  }
}
