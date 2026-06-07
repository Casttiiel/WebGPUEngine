import { vec3 } from 'gl-matrix';
import { BasePlayerController } from './BasePlayerController';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER from '@dimforge/rapier3d';
import type { SwingEntryData } from '../../types/SwingEntryData.type';
import { GameAction } from '../../types/GameAction.enum';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { KCCMovement } from './movement/KCCMovement';
import { WallRunSystem } from './movement/WallRunSystem';
import { DashSystem } from './movement/DashSystem';
import { MantleSystem } from './movement/MantleSystem';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { SwingSystem } from './movement/SwingSystem';
import { PlayerModifiersComponent } from './PlayerModifiersComponent';

/**
 * ParkourControllerComponent — Parkour Character Controller
 *
 * Parkour movement system supporting wall-run, mantle, dash, and swing.
 * Works in both FPS and TPS configurations depending on the camera component used.
 *
 * Requires on the same entity:
 * - CapsuleColliderComponent
 * - KCCMovement (kcc_movement)
 * - A child entity with CameraComponent
 */
export class ParkourControllerComponent
  extends BasePlayerController
  implements IMantleController, IMovementController
{
  // ── Physics ─────────────────────────────────────────────────────────────────
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;
  private camera: CameraComponent | null = null;
  private cameraFound = false;
  private movement!: KCCMovement;

  // ── State ────────────────────────────────────────────────────────────────────
  private isActive = true;
  private movementState: CharacterMovementState = CharacterMovementState.IDLE;
  private inputDisableTimer = -10.0;
  private impulsePadInputDisableTime = 0.5;
  private wasJumpPressed = false;
  private _boostedSpeed = 0.0;
  private wallRunGravity = -2.0;

  // ── Visual rotation (mesh faces movement direction) ──────────────────────────
  private visualYaw: number = 0;
  private readonly turnSpeed: number = 600; // degrees/second — constant angular velocity
  private animator: any = null;
  private animatorFound: boolean = false;

  // ── Systems ──────────────────────────────────────────────────────────────────
  private wallRunSystem!: WallRunSystem;
  private dashSystem!: DashSystem;
  private mantleSystem!: MantleSystem;
  private swingSystem!: SwingSystem;
  private modifiers: PlayerModifiersComponent | null = null;

  // ── Load ─────────────────────────────────────────────────────────────────────
  public async load(data: CharacterControllerComponentDataType): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;
    if (!this.capsuleCollider) {
      console.error('ParkourControllerComponent requires CapsuleColliderComponent!');
      return;
    }
    this.modifiers = this.getOwner().getComponent('player_modifiers') as PlayerModifiersComponent;
    this.impulsePadInputDisableTime =
      data.impulsePadInputDisableTime ?? this.impulsePadInputDisableTime;
    this.wallRunGravity = data.wallRunGravity ?? this.wallRunGravity;

    this.wallRunSystem = new WallRunSystem(this, this.modifiers, data);
    this.dashSystem = new DashSystem(this, this.modifiers);
    this.mantleSystem = new MantleSystem(this, data);
    this.swingSystem = new SwingSystem(this, this.modifiers, data);

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public override async onAttach(): Promise<void> {
    this.movement = this.getOwner().getComponent('kcc_movement') as KCCMovement;
    if (!this.movement) {
      console.error('ParkourControllerComponent requires kcc_movement component!');
    }
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (transform) {
      this.visualYaw = (transform.getTransform().getAngles() as any).yaw ?? 0;
    }
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  public update(dt: number): void {
    if (!this.isActive) return;
    this.findCamera();
    this.findAnimator();
    if (!this.capsuleCollider || !this.camera || !this.movement) return;

    if (this.inputDisableTimer > 0) this.inputDisableTimer -= dt;

    this.movement.updateGroundedState(this.capsuleCollider);
    if (this.movement.isGrounded()) this.dashSystem.onGrounded();

    this.wallRunSystem.detectWall(dt);

    switch (this.movementState) {
      case CharacterMovementState.DASHING: {
        this.dashSystem.updateDash(dt);
        this.movement.applyViaKCC(
          dt,
          this.capsuleCollider,
          this.characterController,
          this.dashSystem.getDashPredicate(),
        );
        break;
      }

      case CharacterMovementState.MANTLING: {
        const mantleDir = this.mantleSystem.updateMantleDirection();
        this.movement.setVelocity(mantleDir);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.WALL_RUNNING: {
        const wallInput = this.getTargetMovement(this.getInputVector());
        this.wallRunSystem.update(dt, wallInput);
        // Apply reduced gravity during wall-run without calling integrate()
        const wallVy = Math.max(
          this.movement.getVerticalVelocity() + this.wallRunGravity * dt,
          -2.0,
        );
        this.movement.setVerticalVelocity(wallVy);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.SWINGING: {
        this.swingSystem.updateSwingMovement(dt);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.IDLE:
      default: {
        const input = Engine.getInput();
        const inputDisabled = this.isInputDisabled();

        if (!inputDisabled) {
          this.mantleSystem.update();
          this.dashSystem.update();

          if (input.isActionBuffered(GameAction.JUMP)) {
            if (this.movement.requestJump()) {
              input.consumeBufferedAction(GameAction.JUMP);
            }
          }
          const jumpPressed = input.isActionPressed(GameAction.JUMP);
          if (this.wasJumpPressed && !jumpPressed) this.movement.releaseJump();
          this.wasJumpPressed = jumpPressed;
        }

        if (!this.movement.isGrounded()) {
          this.wallRunSystem.checkCoyoteWallJump(dt);
        }

        const desired = inputDisabled
          ? vec3.create()
          : vec3.scale(
              vec3.create(),
              this.getTargetMovement(this.getInputVector()),
              this.movement.getMaxSpeed(),
            );

        this.movement.integrate(dt, desired);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }
    }

    this.updateVisualRotation(dt);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private findAnimator(): void {
    if (this.animatorFound) return;
    for (const child of this.getOwner().getChildren()) {
      const anim = child.getComponent('animator');
      if (anim) {
        this.animator = anim;
        break;
      }
    }
    this.animatorFound = true;
  }

  /** Constant-velocity angle rotation — avoids exponential-decay "never arrives" feel. */
  private rotateToward(from: number, to: number, maxDelta: number): number {
    let diff = to - from;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) <= maxDelta) return to;
    return from + Math.sign(diff) * maxDelta;
  }

  /**
   * Rotates the entity (and its child mesh) toward the movement direction each frame.
   * Uses horizontal velocity when moving, falls back to input direction when accelerating
   * from rest. Also drives animator `isMoving` parameter.
   */
  private updateVisualRotation(dt: number): void {
    const hVel = this.movement.getHorizontalVelocity();
    const hSpeed = Math.sqrt(hVel[0] ** 2 + hVel[2] ** 2);

    let facingDir: vec3 | null = null;
    if (hSpeed > 0.3) {
      // Rotate toward actual velocity direction — works for all states
      facingDir = vec3.fromValues(hVel[0] / hSpeed, 0, hVel[2] / hSpeed);
    } else {
      // Use input direction while accelerating from rest so the character turns immediately
      const movDir = this.getTargetMovement(this.getInputVector());
      if (vec3.length(movDir) > 0.01) facingDir = movDir;
    }

    if (facingDir) {
      const desiredYaw = Math.atan2(facingDir[0], facingDir[2]) * (180 / Math.PI);
      this.visualYaw = this.rotateToward(this.visualYaw, desiredYaw, this.turnSpeed * dt);
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (ownerTransform) {
      ownerTransform.getTransform().setAngles(this.visualYaw, 0, 0);
    }

    this.animator?.setParameter('isMoving', hSpeed > 0.5);
  }

  private findCamera(): void {
    if (this.cameraFound) return;
    const children = this.getOwner().getChildren();
    for (const child of children) {
      const cam = child.getComponent('camera') as CameraComponent;
      if (cam) {
        this.camera = cam;
        this.cameraFound = true;
        return;
      }
    }
    console.warn('ParkourControllerComponent: No camera found in children.');
  }

  private getInputVector(): vec3 {
    const input = Engine.getInput();
    const dir = vec3.create();
    if (input.isActionPressed(GameAction.MOVE_FORWARD)) dir[2] -= 1;
    if (input.isActionPressed(GameAction.MOVE_BACKWARD)) dir[2] += 1;
    if (input.isActionPressed(GameAction.MOVE_LEFT)) dir[0] -= 1;
    if (input.isActionPressed(GameAction.MOVE_RIGHT)) dir[0] += 1;
    if (vec3.length(dir) > 0.01) vec3.normalize(dir, dir);
    return dir;
  }

  private getTargetMovement(inputDir: vec3): vec3 {
    if (vec3.length(inputDir) < 0.01) return vec3.create();

    const cam = this.camera!.getCamera();
    const forward = cam.getFront();
    const up = vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), up, forward));
    const forwardXZ = vec3.normalize(vec3.create(), vec3.fromValues(forward[0], 0, forward[2]));
    const rightXZ = vec3.normalize(vec3.create(), vec3.fromValues(right[0], 0, right[2]));

    let target = vec3.add(
      vec3.create(),
      vec3.scale(vec3.create(), forwardXZ, -inputDir[2]),
      vec3.scale(vec3.create(), rightXZ, -inputDir[0]),
    );

    if (this.movement.isGrounded()) {
      target = this.projectOnPlane(
        vec3.fromValues(target[0], 0, target[2]),
        this.movement.getGroundNormal(),
      );
    }
    if (vec3.length(target) > 0.01) vec3.normalize(target, target);
    return target;
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    return vec3.scaleAndAdd(vec3.create(), v, normal, -vec3.dot(v, normal));
  }

  // ── BasePlayerController ─────────────────────────────────────────────────────
  public override setActive(active: boolean): void {
    this.isActive = active;
  }
  public override getCurrentSpeed(): number {
    return this.movement?.getCurrentSpeed() ?? 0;
  }
  public override getMaxSpeed(): number {
    return this.movement?.getMaxSpeed() ?? 0;
  }
  public override getIsGrounded(): boolean {
    return this.movement?.isGrounded() ?? false;
  }
  public override getVerticalVelocity(): number {
    return this.movement?.getVerticalVelocity() ?? 0;
  }
  public override getIsRolling(): boolean {
    return this.movementState === CharacterMovementState.ROLLING;
  }
  public override getIsMantling(): boolean {
    return this.movementState === CharacterMovementState.MANTLING;
  }
  public override getIsWallRunning(): boolean {
    return this.movementState === CharacterMovementState.WALL_RUNNING;
  }
  public override getIsDashing(): boolean {
    return this.movementState === CharacterMovementState.DASHING;
  }
  public override getWallNormal(): vec3 | null {
    return this.wallRunSystem?.getWallNormal() ?? null;
  }
  public override applyImpulseFromPad(impulse: vec3): void {
    this.movement.setVelocity(impulse);
    this.inputDisableTimer = this.impulsePadInputDisableTime;
  }

  // ── IMantleController ────────────────────────────────────────────────────────
  public setVerticalVelocity(v: number): void {
    this.movement.setVerticalVelocity(v);
  }
  public setIsMantling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.MANTLING : CharacterMovementState.IDLE;
  }
  public getIsVaulting(): boolean {
    return this.movementState === CharacterMovementState.VAULTING;
  }
  public setIsVaulting(value: boolean): void {
    this.movementState = value ? CharacterMovementState.VAULTING : CharacterMovementState.IDLE;
  }
  public getHorizontalVelocity(): vec3 {
    return this.movement.getHorizontalVelocity();
  }
  public setHorizontalVelocity(v: vec3): void {
    this.movement.setHorizontalVelocity(v);
  }
  public getCamera(): CameraComponent | null {
    return this.camera;
  }
  public getCollider(): CapsuleColliderComponent {
    return this.capsuleCollider;
  }
  public setIsJumping(value: boolean): void {
    this.movement.setIsJumping(value);
  }

  // ── IMovementController ──────────────────────────────────────────────────────
  public getBoostedSpeed(): number {
    return this._boostedSpeed;
  }
  public setBoostedSpeed(speed: number): void {
    this._boostedSpeed = speed;
  }
  public applyImpulse(impulse: vec3): void {
    this.movement.applyImpulse(impulse);
  }
  public setIsWallRunning(value: boolean): void {
    this.movementState = value ? CharacterMovementState.WALL_RUNNING : CharacterMovementState.IDLE;
  }
  public getIsJumping(): boolean {
    return this.movement?.isJumping() ?? false;
  }
  public setIsDashing(value: boolean): void {
    this.movementState = value ? CharacterMovementState.DASHING : CharacterMovementState.IDLE;
  }
  public getIsGrappling(): boolean {
    return false;
  }
  public setIsGrappling(_value: boolean): void {}
  public getIsSwinging(): boolean {
    return this.movementState === CharacterMovementState.SWINGING;
  }
  public setIsSwinging(value: boolean): void {
    this.movementState = value ? CharacterMovementState.SWINGING : CharacterMovementState.IDLE;
  }
  public setIsRolling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.ROLLING : CharacterMovementState.IDLE;
  }
  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0;
  }
  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }
  public getGroundNormal(): vec3 {
    return this.movement?.getGroundNormal() ?? vec3.fromValues(0, 1, 0);
  }
  public applyJumpFromSystem(): void {
    this.movement.applyJump();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  public startSwing(data: SwingEntryData): void {
    this.swingSystem.startSwing(data);
  }

  // Stubs for roll — RollSystem not active; kept for API compatibility.
  public getRollTimer(): number {
    return 0;
  }
  public getRollDuration(): number {
    return 1;
  }

  public override renderDebug(): void {}
  public override dispose(): void {}
}

// HeadBobComponent imports it under the old alias.
export { ParkourControllerComponent as CharacterControllerComponent };
