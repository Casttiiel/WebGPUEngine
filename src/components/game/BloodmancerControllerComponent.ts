import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { BasePlayerController } from './BasePlayerController';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { GameAction } from '../../types/GameAction.enum';
import type { BloodmancerControllerComponentDataType } from '../../types/BloodmancerControllerComponentData.type';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { MovementSystem } from './movement/MovementSystem';
import { JumpSystem } from './movement/JumpSystem';
import { MantleSystem } from './movement/MantleSystem';
import { IMovementController } from './movement/IMovementController';
import { IMantleController } from './movement/IMantleController';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import { DaggerBurstSystem } from './combat/DaggerBurstSystem';

// ---------------------------------------------------------------------------
// BloodmancerControllerComponent
// ---------------------------------------------------------------------------
// Controlador de personaje para el Bloodmancer. Hereda de BasePlayerController
// e implementa un sistema de estados (switch) análogo al resto de controllers.
//
// Estados soportados:
//   IDLE     — movimiento normal en suelo / aire
//   MANTLING — trepar un saliente
//
// El controller usa los sub-sistemas reutilizables MovementSystem y JumpSystem
// para el movimiento físico base, y MantleSystem para trepar obstáculos.
// ---------------------------------------------------------------------------

export class BloodmancerControllerComponent
  extends BasePlayerController
  implements IMovementController, IMantleController
{
  // ── Física ─────────────────────────────────────────────────────────────────
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;
  private camera: CameraComponent | null = null;
  private cameraFound = false;

  // ── Estado de movimiento ────────────────────────────────────────────────────
  private isActive = true;
  private isGrounded = false;
  private isJumping = false;
  private currentVerticalVelocity = 0.0;
  private boostedSpeed = 0.0;
  private currentHorizontalVelocity: vec3 = vec3.create();
  private movementState: CharacterMovementState = CharacterMovementState.IDLE;
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0);
  private inputDisableTimer = -10.0;
  private impulsePadInputDisableTime = 0.5;

  // ── Sub-sistemas ───────────────────────────────────────────────────────────
  private movementSystem!: MovementSystem;
  private jumpSystem!: JumpSystem;
  private mantleSystem!: MantleSystem;
  private daggerBurstSystem!: DaggerBurstSystem;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async load(data: BloodmancerControllerComponentDataType): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('BloodmancerControllerComponent: CapsuleColliderComponent not found.');
      return;
    }

    this.impulsePadInputDisableTime =
      data.impulsePadInputDisableTime ?? this.impulsePadInputDisableTime;

    // Cast to the shared CharacterControllerComponentDataType that all sub-systems expect.
    const sharedData = data as unknown as CharacterControllerComponentDataType;

    this.movementSystem = new MovementSystem(this, null, sharedData);
    this.jumpSystem = new JumpSystem(this, null, sharedData);
    this.mantleSystem = new MantleSystem(
      this,
      data as unknown as CharacterControllerComponentDataType,
    );

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();

    this.daggerBurstSystem = new DaggerBurstSystem({ poolName: 'DaggerManager' });
  }

  // ---------------------------------------------------------------------------
  // Update — central state machine
  // ---------------------------------------------------------------------------

  public update(deltaTime: number): void {
    if (!this.isActive) return;

    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    this.updateGroundedState();
    this.mantleSystem.update();
    this.daggerBurstSystem.update(deltaTime, this.camera);

    if (this.inputDisableTimer > 0) {
      this.inputDisableTimer -= deltaTime;
    }

    switch (this.movementState) {
      case CharacterMovementState.MANTLING: {
        const mantleMovement = this.mantleSystem.updateMantleDirection();
        this.applyMovement(mantleMovement, deltaTime);
        break;
      }

      case CharacterMovementState.IDLE:
      default: {
        const inputDir = this.getInputVector();
        const targetMovement = this.getTargetMovement(inputDir);
        this.movementSystem.update(deltaTime, targetMovement);
        this.jumpSystem.update(deltaTime);
        const finalVelocity = this.mergeMovements();
        this.applyMovement(finalVelocity, deltaTime);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // BasePlayerController contract
  // ---------------------------------------------------------------------------

  public override setActive(active: boolean): void {
    this.isActive = active;
  }

  public override getIsGrounded(): boolean {
    return this.isGrounded;
  }

  public override getVerticalVelocity(): number {
    return this.currentVerticalVelocity;
  }

  public override getCurrentSpeed(): number {
    return vec3.length(this.currentHorizontalVelocity);
  }

  public override getMaxSpeed(): number {
    return this.movementSystem.getMaxSpeed();
  }

  public override getIsMantling(): boolean {
    return this.movementState === CharacterMovementState.MANTLING;
  }

  public override applyImpulseFromPad(impulse: vec3): void {
    const horizontal = vec3.fromValues(impulse[0], 0, impulse[2]);
    this.jumpSystem.applyJump(impulse[1]);
    this.currentHorizontalVelocity = vec3.clone(horizontal);
    this.inputDisableTimer = this.impulsePadInputDisableTime;
  }

  // ---------------------------------------------------------------------------
  // IMantleController
  // ---------------------------------------------------------------------------

  public setIsMantling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.MANTLING : CharacterMovementState.IDLE;
  }

  // ---------------------------------------------------------------------------
  // IMovementController
  // ---------------------------------------------------------------------------

  public getIsJumping(): boolean {
    return this.isJumping;
  }

  public setIsJumping(value: boolean): void {
    this.isJumping = value;
  }

  public getBoostedSpeed(): number {
    return this.boostedSpeed;
  }

  public setBoostedSpeed(speed: number): void {
    this.boostedSpeed = speed;
  }

  public getHorizontalVelocity(): vec3 {
    return this.currentHorizontalVelocity;
  }

  public setHorizontalVelocity(v: vec3): void {
    vec3.copy(this.currentHorizontalVelocity, v);
  }

  public setVerticalVelocity(v: number): void {
    this.currentVerticalVelocity = v;
  }

  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0.0;
  }

  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }

  public getGroundNormal(): vec3 {
    return this.groundNormal;
  }

  public override getIsWallRunning(): boolean {
    return false;
  }

  public setIsWallRunning(_value: boolean): void {}

  public getIsDashing(): boolean {
    return false;
  }

  public setIsDashing(_value: boolean): void {}

  public getIsGrappling(): boolean {
    return false;
  }

  public setIsGrappling(_value: boolean): void {}

  public getIsSwinging(): boolean {
    return false;
  }

  public setIsSwinging(_value: boolean): void {}

  public override getIsRolling(): boolean {
    return false;
  }

  public setIsRolling(_value: boolean): void {}

  public applyJumpFromSystem(): void {
    const jumpVel = this.jumpSystem.getJumpVelocity();
    this.jumpSystem.applyJump(jumpVel);
  }

  public getCollider(): CapsuleColliderComponent {
    return this.capsuleCollider;
  }

  public getTransform(): TransformComponent {
    return this.getOwner().getComponent('transform') as TransformComponent;
  }

  public getCamera(): CameraComponent | null {
    return this.camera;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findCamera(): void {
    if (this.cameraFound) return;
    for (const child of this.getOwner().getChildren()) {
      const cam = child.getComponent('camera') as CameraComponent;
      if (cam) {
        this.camera = cam;
        this.cameraFound = true;
        return;
      }
    }
  }

  private updateGroundedState(): void {
    const snapDistance = 0.2;
    const hit = this.capsuleCollider.raycastGrounded(snapDistance);
    this.isGrounded = hit !== null;

    if (this.isGrounded && hit) {
      if (hit.normal.y > 0.1) {
        this.groundNormal = vec3.fromValues(hit.normal.x, hit.normal.y, hit.normal.z);
        vec3.normalize(this.groundNormal, this.groundNormal);
      }
    } else {
      this.groundNormal = vec3.fromValues(0, 1, 0);
    }
  }

  private getInputVector(): vec3 {
    const input = Engine.getInput();
    const inputDir = vec3.create();

    if (input.isActionPressed(GameAction.MOVE_FORWARD)) inputDir[2] -= 1;
    if (input.isActionPressed(GameAction.MOVE_BACKWARD)) inputDir[2] += 1;
    if (input.isActionPressed(GameAction.MOVE_LEFT)) inputDir[0] -= 1;
    if (input.isActionPressed(GameAction.MOVE_RIGHT)) inputDir[0] += 1;

    if (vec3.length(inputDir) > 0.01) vec3.normalize(inputDir, inputDir);

    return inputDir;
  }

  private getTargetMovement(inputDir: vec3): vec3 {
    let targetMovement = vec3.create();

    const cameraObj = this.camera!.getCamera();
    const forward = cameraObj.getFront();
    const up = vec3.fromValues(0, 1, 0);

    const right = vec3.cross(vec3.create(), up, forward);
    vec3.normalize(right, right);

    const forwardXZ = vec3.fromValues(forward[0], 0, forward[2]);
    const rightXZ = vec3.fromValues(right[0], 0, right[2]);
    vec3.normalize(forwardXZ, forwardXZ);
    vec3.normalize(rightXZ, rightXZ);

    const forwardMovement = vec3.scale(vec3.create(), forwardXZ, -inputDir[2]);
    const rightMovement = vec3.scale(vec3.create(), rightXZ, -inputDir[0]);
    vec3.add(targetMovement, forwardMovement, rightMovement);

    if (this.isGrounded) {
      if (vec3.length(targetMovement) > 0.01) {
        vec3.normalize(targetMovement, targetMovement);
      }
      const horizontal = vec3.fromValues(targetMovement[0], 0, targetMovement[2]);
      targetMovement = this.projectOnPlane(horizontal, this.groundNormal);
    }

    if (vec3.length(targetMovement) > 0.01) {
      vec3.normalize(targetMovement, targetMovement);
    }

    return targetMovement;
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const proj = vec3.scale(vec3.create(), normal, dot);
    return vec3.subtract(vec3.create(), v, proj);
  }

  private mergeMovements(): vec3 {
    if (this.currentHorizontalVelocity[1] < 0 && this.currentVerticalVelocity > 0) {
      return vec3.fromValues(
        this.currentHorizontalVelocity[0],
        this.currentVerticalVelocity,
        this.currentHorizontalVelocity[2],
      );
    }
    return vec3.fromValues(
      this.currentHorizontalVelocity[0],
      this.currentHorizontalVelocity[1] + this.currentVerticalVelocity,
      this.currentHorizontalVelocity[2],
    );
  }

  private applyMovement(velocity: vec3, dt: number): void {
    const movement = vec3.fromValues(velocity[0] * dt, velocity[1] * dt, velocity[2] * dt);

    this.characterController.computeColliderMovement(
      this.capsuleCollider.getCollider(),
      new RAPIER.Vector3(movement[0], movement[1], movement[2]),
      QueryFilterFlags.EXCLUDE_SENSORS,
    );

    const correctedMovement = this.characterController.computedMovement();
    const newVel = {
      x: correctedMovement.x / dt,
      y: correctedMovement.y / dt,
      z: correctedMovement.z / dt,
    };
    this.capsuleCollider.getRigidBody().setLinvel(newVel, true);

    // Cancel special states on geometry collision
    for (let i = 0; i < this.characterController.numComputedCollisions(); i++) {
      const collision = this.characterController.computedCollision(i);
      if (!collision?.collider) continue;

      const rb = collision.collider.parent();
      if (!rb) continue;

      if (rb.bodyType() === RAPIER.RigidBodyType.Fixed) {
        const n = vec3.fromValues(collision.normal1.x, collision.normal1.y, collision.normal1.z);
        const isWall = Math.abs(n[1]) < 0.5;
        if (isWall) {
          this.removeVelocityIntoWall(n);
          this.boostedSpeed = 0.0;
        }
      }
    }
  }

  private removeVelocityIntoWall(wallNormal: vec3): void {
    const vel = this.currentHorizontalVelocity;
    const dot = vec3.dot(vel, wallNormal);
    if (dot < 0) {
      const proj = vec3.scale(vec3.create(), wallNormal, dot);
      vec3.subtract(vel, vel, proj);
    }
  }

  public override renderDebug(): void {
    throw new Error('Method not implemented.');
  }
  public getIsVaulting(): boolean {
    throw new Error('Method not implemented.');
  }
  public setIsVaulting(_value: boolean): void {
    throw new Error('Method not implemented.');
  }
}
