import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { KCCMovement } from './movement/KCCMovement';
import type { IKickable } from './combat/IKickable';

/** Shared zero-vector passed to KCCMovement — dummy never desires horizontal movement. */
const _ZERO_DESIRED: vec3 = vec3.create();

/**
 * DummyEnemyController — Kinematic gravity-only controller with no AI.
 *
 * Keeps the capsule grounded exactly like EnemyControllerComponent but with
 * zero behaviour: no BehaviorTree, no perception, no movement.
 * Intended purely as a training / ability-testing target.
 *
 * Component key: 'dummy_enemy_controller'
 */
export class DummyEnemyController extends Component implements IKickable {
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;

  /** Velocity integration, gravity, air drag, and KCC application. */
  private movement!: KCCMovement;

  // Throttle ground checks to ~20 Hz
  private groundTimer: number = 0;

  public async load(): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('DummyEnemyController: CapsuleColliderComponent not found.');
      return;
    }

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public override async onAttach(): Promise<void> {
    this.movement = this.getOwner().getComponent('kcc_movement') as KCCMovement;
    if (!this.movement) {
      console.error('DummyEnemyController: KCCMovement component not found.');
    }
  }

  public applyKnockback(impulse: vec3): void {
    this.movement.applyImpulse(impulse);
  }

  public renderDebug(): void {}

  public update(deltaTime: number): void {
    if (!this.capsuleCollider || !this.characterController) return;

    // Ground detection throttled to 20 Hz
    this.groundTimer += deltaTime;
    if (this.groundTimer >= 0.05) {
      this.groundTimer = 0;
      this.movement.updateGroundedState(this.capsuleCollider, 0.2);
    }

    // KCCMovement handles gravity + air drag; no desired horizontal (dummy doesn't walk).
    this.movement.integrate(deltaTime, _ZERO_DESIRED);
    this.movement.applyViaKCC(deltaTime, this.capsuleCollider, this.characterController);
  }

  public override dispose(): void {}
}
