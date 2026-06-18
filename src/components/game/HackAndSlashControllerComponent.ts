import { vec3 } from 'gl-matrix';
import { BasePlayerController } from './BasePlayerController';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER from '@dimforge/rapier3d';
import { GameAction } from '../../types/GameAction.enum';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { KCCMovement } from './movement/KCCMovement';
import { MantleSystem } from './movement/MantleSystem';
import { RollSystem } from './movement/RollSystem';
import { HoverSystem } from './movement/HoverSystem';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { PlayerModifiersComponent } from './PlayerModifiersComponent';
import type { HitStopComponent } from './HitStopComponent';

/**
 * HackAndSlashControllerComponent — Hack & Slash Character Controller
 *
 * Sistema de movimiento para combate hack & slash.
 * Soporta mantle, roll/esquiva y levitar (hover).
 *
 * Requires on the same entity:
 * - CapsuleColliderComponent
 * - KCCMovement (kcc_movement)
 * - A child entity with CameraComponent
 */
export class HackAndSlashControllerComponent
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

  // ── Visual rotation (mesh faces movement direction) ──────────────────────────
  private visualYaw: number = 0;
  private smoothedDesiredYaw: number | null = null;
  private readonly targetSmoothSpeed: number = 15;
  private readonly turnSpeed: number = 20;
  private animator: any = null;
  private animatorFound: boolean = false;

  // ── Jump animation ────────────────────────────────────────────────────────────
  private _wasGrounded: boolean = true;
  private _landLayerId: number = -1;
  private _landLayerElapsed: number = 0;
  private _jumpStartLayerId: number = -1;
  private _airTimer: number = 0;

  // ── Systems ──────────────────────────────────────────────────────────────────
  private mantleSystem!: MantleSystem;
  private rollSystem!: RollSystem;
  private hoverSystem!: HoverSystem;
  private modifiers: PlayerModifiersComponent | null = null;

  // ── Load ─────────────────────────────────────────────────────────────────────
  public async load(data: CharacterControllerComponentDataType): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;
    if (!this.capsuleCollider) {
      console.error('HackAndSlashControllerComponent requires CapsuleColliderComponent!');
      return;
    }
    this.modifiers = this.getOwner().getComponent('player_modifiers') as PlayerModifiersComponent;
    this.impulsePadInputDisableTime =
      data.impulsePadInputDisableTime ?? this.impulsePadInputDisableTime;

    this.mantleSystem = new MantleSystem(this, data);
    this.rollSystem = new RollSystem(this, this.modifiers);
    this.hoverSystem = new HoverSystem(this);

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public override async onAttach(): Promise<void> {
    this.movement = this.getOwner().getComponent('kcc_movement') as KCCMovement;
    if (!this.movement) {
      console.error('HackAndSlashControllerComponent requires kcc_movement component!');
    }
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (transform) {
      this.visualYaw = (transform.getTransform().getAngles() as any).yaw ?? 0;
    }
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  public update(dt: number): void {
    if (!this.isActive) return;
    if ((this.getOwner().getComponent('hit_stop') as HitStopComponent | null)?.isFrozen()) return;
    this.findCamera();
    this.findAnimator();
    if (!this.capsuleCollider || !this.camera || !this.movement) return;

    if (this.inputDisableTimer > 0) this.inputDisableTimer -= dt;

    this.movement.updateGroundedState(this.capsuleCollider);

    switch (this.movementState) {
      case CharacterMovementState.MANTLING: {
        const mantleDir = this.mantleSystem.updateMantleDirection();
        this.movement.setVelocity(mantleDir);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.ROLLING: {
        const rollVelocity = this.rollSystem.updateRollMovement(dt);
        // Air roll: freeze vertical so the character holds height during the roll.
        // Ground roll: preserve vy (-0.5 stick) so slopes are handled correctly.
        if (!this.movement.isGrounded()) {
          this.movement.setVerticalVelocity(0);
        }
        this.movement.setHorizontalVelocity(rollVelocity);
        this.movement.applyViaKCC(dt, this.capsuleCollider, this.characterController);
        break;
      }

      case CharacterMovementState.IDLE:
      default: {
        const input = Engine.getInput();
        const inputDisabled = this.isInputDisabled();

        if (!inputDisabled) {
          this.mantleSystem.update();
          this.rollSystem.update(dt, this.getTargetMovement(this.getInputVector()));

          if (input.isActionBuffered(GameAction.JUMP)) {
            if (this.movement.requestJump()) {
              input.consumeBufferedAction(GameAction.JUMP);
              this._jumpStartLayerId =
                this.animator?.addLayer('Jump_Start', {
                  loop: false,
                  weight: 1.0,
                  blendInTime: 0.08,
                }) ?? -1;
            }
          }
          const jumpPressed = input.isActionPressed(GameAction.JUMP);
          if (this.wasJumpPressed && !jumpPressed) this.movement.releaseJump();
          this.wasJumpPressed = jumpPressed;
        }

        this.hoverSystem.update(dt);

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

  private lerpAngle(from: number, to: number, t: number): number {
    let diff = to - from;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return from + diff * t;
  }

  private updateVisualRotation(dt: number): void {
    const hVel = this.movement.getHorizontalVelocity();
    const hSpeed = Math.sqrt(hVel[0] ** 2 + hVel[2] ** 2);

    let facingDir: vec3 | null = null;
    // Facing and movement are locked during the entire roll; only resume when
    // the roll ends and velocity is back to zero.
    if (!this.getIsRolling()) {
      const movDir = this.getTargetMovement(this.getInputVector());
      if (vec3.length(movDir) > 0.01) {
        facingDir = movDir;
      }
    }
    if (!facingDir && hSpeed > 0.3) {
      facingDir = vec3.fromValues(hVel[0] / hSpeed, 0, hVel[2] / hSpeed);
    }

    if (facingDir) {
      const rawYaw = Math.atan2(facingDir[0], facingDir[2]) * (180 / Math.PI);
      if (this.smoothedDesiredYaw === null) this.smoothedDesiredYaw = rawYaw;
      const t1 = 1 - Math.exp(-this.targetSmoothSpeed * dt);
      this.smoothedDesiredYaw = this.lerpAngle(this.smoothedDesiredYaw, rawYaw, t1);
      const t2 = 1 - Math.exp(-this.turnSpeed * dt);
      this.visualYaw = this.lerpAngle(this.visualYaw, this.smoothedDesiredYaw, t2);
    } else {
      this.smoothedDesiredYaw = null;
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (ownerTransform) {
      ownerTransform.getTransform().setAngles(this.visualYaw, 0, 0);
    }

    this.animator?.setParameter('isMoving', hSpeed > 0.5);

    const isGrounded = this.movement.isGrounded();
    this._airTimer = isGrounded ? 0 : this._airTimer + dt;
    this.animator?.setParameter('isInAir', this._airTimer > 0.15);

    if (!this._wasGrounded && isGrounded) {
      if (this._jumpStartLayerId >= 0) {
        this.animator?.removeLayer(this._jumpStartLayerId, 0.1);
        this._jumpStartLayerId = -1;
      }
      const landSpeed = 1.0 + Math.min(hSpeed * 0.25, 2.5);
      this._landLayerId =
        this.animator?.addLayer('Jump_Land', {
          loop: false,
          weight: 1.0,
          blendInTime: 0.08,
          speed: landSpeed,
        }) ?? -1;
      this._landLayerElapsed = 0;
    }

    if (this._landLayerId >= 0) {
      this._landLayerElapsed += dt;
      if (this._landLayerElapsed > 0.2 && hSpeed > 2.0) {
        this.animator?.removeLayer(this._landLayerId, 0.15);
        this._landLayerId = -1;
      }
    }

    this._wasGrounded = isGrounded;
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
    console.warn('HackAndSlashControllerComponent: No camera found in children.');
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
    return false;
  }
  public override getIsDashing(): boolean {
    return false;
  }
  public override getWallNormal(): vec3 | null {
    return null;
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
  public setIsWallRunning(_value: boolean): void {}
  public getIsJumping(): boolean {
    return this.movement?.isJumping() ?? false;
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
  public setGravityScale(scale: number): void {
    this.movement?.setGravityScale(scale);
  }
  public applyJumpFromSystem(): void {
    this.movement.applyJump();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  public getRollTimer(): number {
    return this.rollSystem?.getRollTimer() ?? 0;
  }
  public getRollDuration(): number {
    return this.rollSystem?.getRollDuration() ?? 1;
  }

  public override renderDebug(): void {}
  public override dispose(): void {}
}
