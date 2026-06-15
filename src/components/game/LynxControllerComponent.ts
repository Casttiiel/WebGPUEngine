import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { BasePlayerController } from './BasePlayerController';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { KCCMovement } from './movement/KCCMovement';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { GameAction } from '../../types/GameAction.enum';
import { KickSystem } from './combat/KickSystem';
import { ThrowingProjectileSystem } from './combat/ThrowingProjectileSystem';
import { BlinkSystem } from './movement/BlinkSystem';
import { WallJumpSystem } from './movement/WallJumpSystem';
import type { LynxControllerComponentDataType } from '../../types/LynxControllerComponentData.type';

export class LynxControllerComponent
  extends BasePlayerController
  implements IMovementController, IMantleController
{
  // ── Physics ─────────────────────────────────────────────────────────────────
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;
  private camera: CameraComponent | null = null;
  private cameraFound = false;

  // ── Movement state ───────────────────────────────────────────────────────────
  private isActive = true;
  private wasGrounded = false;
  private movementState: CharacterMovementState = CharacterMovementState.IDLE;
  private inputDisableTimer = -10.0;
  private impulsePadInputDisableTime = 0.5;
  private wasJumpPressed = false;

  private movement!: KCCMovement;
  /*private mantleSystem!: MantleSystem;
  private vaultSystem!: VaultSystem;*/

  private kickSystem!: KickSystem;
  private throwSystem!: ThrowingProjectileSystem;
  private dashSystem!: BlinkSystem;
  private wallJumpSystem!: WallJumpSystem;

  public async load(data: LynxControllerComponentDataType): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('LynxControllerComponent: CapsuleColliderComponent not found.');
      return;
    }

    this.impulsePadInputDisableTime = this.impulsePadInputDisableTime;

    /*this.mantleSystem = new MantleSystem(this, data);
    this.vaultSystem = new VaultSystem(this);*/

    this.kickSystem = new KickSystem(this);

    this.throwSystem = new ThrowingProjectileSystem();

    this.dashSystem = new BlinkSystem(this, null);
    this.wallJumpSystem = new WallJumpSystem(this);

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public override async onAttach(): Promise<void> {
    this.movement = this.getOwner().getComponent('kcc_movement') as KCCMovement;
    if (!this.movement) {
      console.error('LynxControllerComponent: KCCMovement component not found.');
    }
  }

  // ---------------------------------------------------------------------------
  // Update — central state machine
  // ---------------------------------------------------------------------------

  public update(deltaTime: number): void {
    if (!this.isActive) return;

    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    this.updateGroundedState();

    // Notify kick system when the player lands.
    if (this.movement.isGrounded()) {
      // && !this.wasGrounded
      this.kickSystem.onGrounded();
      this.dashSystem.onGrounded();
    }
    this.wasGrounded = this.movement.isGrounded();

    if (this.inputDisableTimer > 0) {
      this.inputDisableTimer -= deltaTime;
    }

    // Mantle / Vault detection runs during IDLE only.
    if (this.movementState === CharacterMovementState.IDLE) {
      /*this.mantleSystem.update();
      this.vaultSystem.update();*/
      this.kickSystem.update(deltaTime);
      this.throwSystem.update(deltaTime, this.camera);
      this.dashSystem.update();
      this.wallJumpSystem.update(deltaTime);
    }

    switch (this.movementState) {
      /*
      case CharacterMovementState.MANTLING: {
        const mantleMovement = this.mantleSystem.updateMantleDirection();
        this.movement.setVelocity(mantleMovement);
        this.movement.applyViaKCC(deltaTime, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.VAULTING: {
        const vaultMovement = this.vaultSystem.updateVaultMovement();
        this.movement.setVelocity(vaultMovement);
        this.movement.applyViaKCC(deltaTime, this.capsuleCollider, this.characterController);
        break;
      }*/

      case CharacterMovementState.DASHING: {
        this.dashSystem.updateBlink(deltaTime);
        this.movement.applyViaKCC(
          deltaTime,
          this.capsuleCollider,
          this.characterController,
          this.dashSystem.getBlinkPredicate(),
        );
        break;
      }

      case CharacterMovementState.IDLE:
      default: {
        const input = Engine.getInput();
        const inputDisabled = this.isInputDisabled();

        if (!inputDisabled) {
          // Wall jump tiene prioridad sobre el salto normal en el aire
          if (!this.movement.isGrounded() && this.wallJumpSystem.tryWallJump()) {
            // wall jump aplicado — el salto normal se omite este frame
          } else if (input.isActionBuffered(GameAction.JUMP)) {
            if (this.movement.requestJump()) {
              input.consumeBufferedAction(GameAction.JUMP);
            }
          }
          const jumpPressed = input.isActionPressed(GameAction.JUMP);
          if (this.wasJumpPressed && !jumpPressed) {
            this.movement.releaseJump();
          }
          this.wasJumpPressed = jumpPressed;
        }

        // Horizontal movement — zero desired when input is disabled (gravity still applies).
        const desiredVelocity = inputDisabled
          ? vec3.create()
          : vec3.scale(
              vec3.create(),
              this.getTargetMovement(this.getInputVector()),
              this.movement.getMaxSpeed(),
            );

        this.movement.integrate(deltaTime, desiredVelocity);
        this.movement.applyViaKCC(deltaTime, this.capsuleCollider, this.characterController);
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
    return this.movement.isGrounded();
  }

  public override getVerticalVelocity(): number {
    return this.movement.getVerticalVelocity();
  }

  public override getCurrentSpeed(): number {
    return this.movement.getCurrentSpeed();
  }

  public override getMaxSpeed(): number {
    return this.movement.getMaxSpeed();
  }

  public override getIsMantling(): boolean {
    return this.movementState === CharacterMovementState.MANTLING;
  }

  public override applyImpulseFromPad(impulse: vec3): void {
    this.movement.setVelocity(impulse);
    this.inputDisableTimer = this.impulsePadInputDisableTime;
  }

  // ---------------------------------------------------------------------------
  // IMantleController
  // ---------------------------------------------------------------------------

  public setIsMantling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.MANTLING : CharacterMovementState.IDLE;
  }

  public getIsVaulting(): boolean {
    return this.movementState === CharacterMovementState.VAULTING;
  }

  public setIsVaulting(value: boolean): void {
    this.movementState = value ? CharacterMovementState.VAULTING : CharacterMovementState.IDLE;
  }

  public setIsJumping(value: boolean): void {
    this.movement.setIsJumping(value);
  }

  public getHorizontalVelocity(): vec3 {
    return this.movement.getHorizontalVelocity();
  }

  public setHorizontalVelocity(v: vec3): void {
    this.movement.setHorizontalVelocity(v);
  }

  public setVerticalVelocity(v: number): void {
    this.movement.setVerticalVelocity(v);
  }

  public getCollider(): CapsuleColliderComponent {
    return this.capsuleCollider;
  }

  public getCamera(): CameraComponent | null {
    return this.camera;
  }

  public getTransform(): TransformComponent {
    return this.getOwner().getComponent('transform') as TransformComponent;
  }

  // ---------------------------------------------------------------------------
  // IMovementController
  // ---------------------------------------------------------------------------

  public getIsJumping(): boolean {
    return this.movement.isJumping();
  }

  public getBoostedSpeed(): number {
    return 0;
  }

  public setBoostedSpeed(_speed: number): void {}

  public applyImpulse(impulse: vec3): void {
    this.movement.applyImpulse(impulse);
  }

  public override getIsWallRunning(): boolean {
    return false;
  }

  public setIsWallRunning(_value: boolean): void {}

  public override getIsDashing(): boolean {
    return this.movementState === CharacterMovementState.DASHING;
  }

  public setIsDashing(value: boolean): void {
    this.movementState = value ? CharacterMovementState.DASHING : CharacterMovementState.IDLE;
  }

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

  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0;
  }

  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }

  public getGroundNormal(): vec3 {
    return this.movement.getGroundNormal();
  }
  public setGravityScale(scale: number): void {
    this.movement.setGravityScale(scale);
  }

  public applyJumpFromSystem(): void {
    this.movement.applyJump();
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
    this.movement.updateGroundedState(this.capsuleCollider, 0.2);
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

    if (this.movement.isGrounded()) {
      if (vec3.length(targetMovement) > 0.01) {
        vec3.normalize(targetMovement, targetMovement);
      }
      const horizontal = vec3.fromValues(targetMovement[0], 0, targetMovement[2]);
      targetMovement = this.projectOnPlane(horizontal, this.movement.getGroundNormal());
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

  public override renderDebug(): void {}

  public override dispose(): void {}
}
