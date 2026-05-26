import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';

/**
 * DummyEnemyController — Kinematic gravity-only controller with no AI.
 *
 * Keeps the capsule grounded exactly like EnemyControllerComponent but with
 * zero behaviour: no BehaviorTree, no perception, no movement.
 * Intended purely as a training / ability-testing target.
 *
 * Component key: 'dummy_enemy_controller'
 */
export class DummyEnemyController extends Component {
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;

  private verticalVelocity: number = 0;
  private isGrounded: boolean = false;
  private readonly gravity: number = 20;

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

  public update(deltaTime: number): void {
    if (!this.capsuleCollider || !this.characterController) return;

    // Ground detection throttled to 20 Hz
    this.groundTimer += deltaTime;
    if (this.groundTimer >= 0.05) {
      this.groundTimer = 0;
      this.isGrounded = this.capsuleCollider.raycastGrounded(0.2) !== null;
    }

    // Gravity
    if (this.isGrounded && this.verticalVelocity < 0) {
      this.verticalVelocity = -0.5;
    } else {
      this.verticalVelocity -= this.gravity * deltaTime;
    }

    // Apply through KCC (zero horizontal, only gravity)
    const movement = new RAPIER.Vector3(0, this.verticalVelocity * deltaTime, 0);

    this.characterController.computeColliderMovement(
      this.capsuleCollider.getCollider(),
      movement,
      QueryFilterFlags.EXCLUDE_SENSORS,
    );

    const corrected = this.characterController.computedMovement();
    this.capsuleCollider
      .getRigidBody()
      .setLinvel(
        { x: corrected.x / deltaTime, y: corrected.y / deltaTime, z: corrected.z / deltaTime },
        true,
      );
  }

  public override dispose(): void {}
}
