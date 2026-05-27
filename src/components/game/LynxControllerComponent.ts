import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { BasePlayerController } from './BasePlayerController';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { KCCMovement } from './movement/KCCMovement';
import { MantleSystem } from './movement/MantleSystem';
import { VaultSystem } from './movement/VaultSystem';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { GameAction } from '../../types/GameAction.enum';
import { MarkSystem } from './combat/MarkSystem';
import { MarkerShotSystem } from './combat/MarkerShotSystem';
import { LynxDashPunchSystem } from './combat/LynxDashPunchSystem';
import { KickSystem } from './combat/KickSystem';
import { BulletPoolComponent } from './BulletPoolComponent';
import { MarkerBillboardSystem } from './combat/MarkerBillboardSystem';
import type { LynxControllerComponentDataType } from '../../types/LynxControllerComponentData.type';

// ---------------------------------------------------------------------------
// LynxControllerComponent
// ---------------------------------------------------------------------------
// Player controller for the Lynx character.
//
// Movement:   WASD + mouse look, double jump, mantle, vault.
// Ability 1:  Marker shots (LMB) — 3 charges, regen 1/2.5 s, mark enemies.
// Ability 2:  Dash punch (ABILITY_Q) — lunge in look direction (full 3D),
//             collision damage; hits marked enemies reset the 10 s cooldown.
//
// States (mutually exclusive):
//   IDLE      — normal ground/air movement
//   MANTLING  — climbing a ledge
//   VAULTING  — clearing a low obstacle
//   DASHING   — executing the dash punch
// ---------------------------------------------------------------------------

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

  // ── Sub-systems ──────────────────────────────────────────────────────────────
  private movement!: KCCMovement;
  private mantleSystem!: MantleSystem;
  private vaultSystem!: VaultSystem;

  private markSystem!: MarkSystem;
  private markerShotSystem!: MarkerShotSystem;
  private dashPunchSystem!: LynxDashPunchSystem;
  private kickSystem!: KickSystem;
  private bulletPool: BulletPoolComponent | null = null;
  private markerBillboard!: MarkerBillboardSystem;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async load(data: LynxControllerComponentDataType): Promise<void> {
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('LynxControllerComponent: CapsuleColliderComponent not found.');
      return;
    }

    this.impulsePadInputDisableTime =
      data.impulsePadInputDisableTime ?? this.impulsePadInputDisableTime;

    this.movement = new KCCMovement({
      maxSpeed: data.moveSpeed ?? 11,
      groundAcceleration: data.groundAcceleration ?? 65,
      groundDeceleration: data.groundDeceleration ?? 65,
      airControl: data.airControl ?? 0.65,
      airDrag: data.airDrag ?? 0.3,
      ...(data.jumpHeight !== undefined ? { jumpHeight: data.jumpHeight } : {}),
      ...(data.jumpTimeToPeak !== undefined ? { jumpTimeToPeak: data.jumpTimeToPeak } : {}),
      ...(data.jumpTimeToDescent !== undefined
        ? { jumpTimeToDescent: data.jumpTimeToDescent }
        : {}),
      ...(data.jumpCutFactor !== undefined ? { jumpCutFactor: data.jumpCutFactor } : {}),
      ...(data.jumpCutVerticalVelocityLimit !== undefined
        ? { jumpCutVelocityLimit: data.jumpCutVerticalVelocityLimit }
        : {}),
      ...(data.coyoteTime !== undefined ? { coyoteTime: data.coyoteTime } : {}),
      maxAirJumps: data.maxAirJumps ?? 1,
    });

    this.mantleSystem = new MantleSystem(this, data);
    this.vaultSystem = new VaultSystem(this);

    this.markSystem = new MarkSystem();

    this.markerShotSystem = new MarkerShotSystem({
      maxCharges: data.markerMaxCharges ?? 3,
      rechargeTime: data.markerRechargeTime ?? 2.5,
      shotDamage: data.markerShotDamage ?? 5,
      markDuration: data.markerMarkDuration ?? 15,
    });

    this.markerBillboard = new MarkerBillboardSystem();

    this.dashPunchSystem = new LynxDashPunchSystem({
      dashSpeed: data.dashPunchSpeed ?? 28,
      maxDashDistance: data.dashPunchMaxDistance ?? 12,
      punchDamage: data.dashPunchDamage ?? 60,
      cooldownDuration: data.dashPunchCooldown ?? 10,
    });

    this.kickSystem = new KickSystem(this, {
      ...(data.kickDetectionDistance !== undefined
        ? { detectionDistance: data.kickDetectionDistance }
        : {}),
      ...(data.kickEnemyKnockbackForce !== undefined
        ? { enemyKnockbackForce: data.kickEnemyKnockbackForce }
        : {}),
      ...(data.kickEnemyKnockbackDuration !== undefined
        ? { enemyKnockbackDuration: data.kickEnemyKnockbackDuration }
        : {}),
      ...(data.kickCooldown !== undefined ? { cooldown: data.kickCooldown } : {}),
      ...(data.kickSelfInputDisableTime !== undefined
        ? { selfInputDisableTime: data.kickSelfInputDisableTime }
        : {}),
    });

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
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
    if (this.movement.isGrounded() && !this.wasGrounded) {
      this.kickSystem.onGrounded();
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

      // Try to start the dash punch.
      /*if (this.dashPunchSystem.tryStart(this.camera)) {
        // Freeze velocity while dashing.
        this.movement.setVelocity(vec3.create());
        this.movementState = CharacterMovementState.DASHING;
      }*/
    }

    switch (this.movementState) {
      /*case CharacterMovementState.DASHING: {
        const dashVelocity = this.dashPunchSystem.updateDashMovement(
          deltaTime,
          this,
          this.markSystem,
        );
        if (!this.dashPunchSystem.isActive()) {
          // Dash ended — zero out velocity and return to IDLE.
          this.movement.setVelocity(vec3.create());
          this.movementState = CharacterMovementState.IDLE;
        } else {
          this.movement.setVelocity(dashVelocity);
          this.movement.applyViaKCC(deltaTime, this.capsuleCollider, this.characterController);
          // Dash wall collision — end dash on fixed geometry wall.
          for (let i = 0; i < this.characterController.numComputedCollisions(); i++) {
            const collision = this.characterController.computedCollision(i);
            if (!collision?.collider) continue;
            const rb = collision.collider.parent();
            if (!rb) continue;
            if (rb.bodyType() === RAPIER.RigidBodyType.Fixed) {
              const n = vec3.fromValues(
                collision.normal1.x,
                collision.normal1.y,
                collision.normal1.z,
              );
              if (Math.abs(n[1]) < 0.5) {
                this.movementState = CharacterMovementState.IDLE;
                this.movement.setVelocity(vec3.create());
                break;
              }
            }
          }
        }
        break;
      }

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

      case CharacterMovementState.IDLE:
      default: {
        const input = Engine.getInput();

        // Jump input: request on buffered press, release on button release.
        if (input.isActionBuffered(GameAction.JUMP)) {
          if (this.movement.requestJump()) {
            input.consumeBufferedAction(GameAction.JUMP);
          }
        }
        const jumpPressed = input.isActionPressed(GameAction.JUMP);
        if (this.wasJumpPressed && !jumpPressed) {
          this.movement.releaseJump();
        }
        this.wasJumpPressed = jumpPressed;

        // Horizontal movement.
        const inputDir = this.getInputVector();
        const targetDir = this.getTargetMovement(inputDir);
        const maxSpeed = this.movement.getMaxSpeed();
        const desiredVelocity = vec3.scale(vec3.create(), targetDir, maxSpeed);

        this.movement.update(deltaTime, desiredVelocity);
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
    this.movement.applyImpulse(impulse);
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

  public override getIsWallRunning(): boolean {
    return false;
  }

  public setIsWallRunning(_value: boolean): void {}

  public getIsDashing(): boolean {
    return this.movementState === CharacterMovementState.DASHING;
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

  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0;
  }

  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }

  public getGroundNormal(): vec3 {
    return this.movement.getGroundNormal();
  }

  public applyJumpFromSystem(): void {
    this.movement.applyJump();
  }

  // ---------------------------------------------------------------------------
  // Ability queries (for HUD / debug)
  // ---------------------------------------------------------------------------

  public getMarkerCharges(): number {
    return this.markerShotSystem.getCharges();
  }

  public getMarkerMaxCharges(): number {
    return this.markerShotSystem.getMaxCharges();
  }

  public getMarkerRechargeProgress(): number {
    return this.markerShotSystem.getRechargeProgress();
  }

  public getDashCooldownTimer(): number {
    return this.dashPunchSystem.getCooldownTimer();
  }

  public getDashCooldownDuration(): number {
    return this.dashPunchSystem.getCooldownDuration();
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
