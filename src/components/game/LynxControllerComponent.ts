import { vec3, quat } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Loader } from '../../core/loaders/Loader';
import type { EntityDataType } from '../../types/SceneData.type';
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
import { SpearThrowSystem } from './combat/SpearThrowSystem';
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

  private dashPunchSystem!: LynxDashPunchSystem;
  private kickSystem!: KickSystem;
  private spearThrowSystem!: SpearThrowSystem;

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

    this.mantleSystem = new MantleSystem(this, data);
    this.vaultSystem = new VaultSystem(this);

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

    this.spearThrowSystem = new SpearThrowSystem(
      data.spearEntityName !== undefined ? { spearEntityName: data.spearEntityName } : undefined,
    );

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
      this.spearThrowSystem.update(deltaTime, this.camera, this.getTransform());

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
        const inputDisabled = this.isInputDisabled();

        if (!inputDisabled) {
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

          if (input.isActionJustPressed(GameAction.INTERACT)) {
            this.trySpawnImpulsePad();
          }
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

  // ---------------------------------------------------------------------------
  // Impulse pad spawner
  // ---------------------------------------------------------------------------

  private trySpawnImpulsePad(): void {
    if (!this.camera) return;

    const cam = this.camera.getCamera();
    const camPos = cam.getPosition();
    const camFront = cam.getFront();

    const ray = new RAPIER.Ray(
      { x: camPos[0], y: camPos[1], z: camPos[2] },
      { x: camFront[0], y: camFront[1], z: camFront[2] },
    );

    const hit = Engine.getPhysics()
      .getWorld()
      .castRayAndGetNormal(
        ray,
        10.0,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.capsuleCollider.getCollider(),
      );

    if (!hit) return;

    const t = hit.timeOfImpact;
    const normal = vec3.fromValues(hit.normal.x, hit.normal.y, hit.normal.z);
    const hitPoint = vec3.fromValues(
      camPos[0] + camFront[0] * t,
      camPos[1] + camFront[1] * t,
      camPos[2] + camFront[2] * t,
    );
    const spawnPos = vec3.scaleAndAdd(vec3.create(), hitPoint, normal, 0.02);

    // Shortest rotation from Y-up to the surface normal → Euler degrees
    // (combineTransforms only handles Euler, not quaternion)
    const q = quat.rotationTo(quat.create(), vec3.fromValues(0, 1, 0), normal);
    const toDeg = 180 / Math.PI;
    const pitchX =
      Math.atan2(2 * (q[3] * q[0] + q[1] * q[2]), 1 - 2 * (q[0] * q[0] + q[1] * q[1])) * toDeg;
    const yawY = Math.asin(Math.max(-1, Math.min(1, 2 * (q[3] * q[1] - q[2] * q[0])))) * toDeg;
    const rollZ =
      Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * toDeg;

    const entityData = {
      prefab: 'gameplay/impulse_pad_15.prefab',
      components: {
        transform: {
          position: [spawnPos[0], spawnPos[1], spawnPos[2]] as [number, number, number],
          rotation: [pitchX, yawY, rollZ] as [number, number, number],
        },
      },
    } as unknown as EntityDataType;

    Loader.parseEntityFromJSON(entityData)
      .then((parsed) => Loader.loadEntityFromJSON(parsed, undefined, false))
      .catch((e) => console.error('[LynxController] Failed to spawn impulse pad:', e));
  }
}
