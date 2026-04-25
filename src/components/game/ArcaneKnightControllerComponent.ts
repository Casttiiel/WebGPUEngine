import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { BasePlayerController } from './BasePlayerController';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { GameAction } from '../../types/GameAction.enum';
import type { ArcaneKnightControllerComponentDataType } from '../../types/ArcaneKnightControllerComponentData.type';

import { CombatSystem } from './combat/CombatSystem';
import { ThrowSystem } from './combat/ThrowSystem';
import { DaggerHUDSystem } from './combat/DaggerHUDSystem';
import { MantleSystem } from './movement/MantleSystem';
import { MovementSystem } from './movement/MovementSystem';
import { JumpSystem } from './movement/JumpSystem';
import { SwingSystem } from './movement/SwingSystem';
import { DodgeSystem } from './movement/DodgeSystem';
import { GrappleSystem } from './movement/GrappleSystem';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import { SwingEntryData } from '../../types/SwingEntryData.type';

export class ArcaneKnightControllerComponent
  extends BasePlayerController
  implements IMantleController, IMovementController
{
  // ============================================
  // REFERENCIAS FÍSICAS
  // ============================================
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;
  private camera: CameraComponent | null = null;
  private cameraFound: boolean = false;

  // ============================================
  // ESTADO DE MOVIMIENTO
  // ============================================
  private isActive: boolean = true;
  private isGrounded: boolean = false;
  private isJumping: boolean = false;
  private currentVerticalVelocity: number = 0.0;
  private boostedSpeed: number = 0.0;
  private currentHorizontalVelocity: vec3 = vec3.create();
  private movementState: CharacterMovementState = CharacterMovementState.IDLE;

  // ──── Parámetros de movimiento ────
  private inputDisableTimer: number = -10.0;
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0);

  private combatSystem!: CombatSystem;
  private throwSystem!: ThrowSystem;
  private daggerHUD!: DaggerHUDSystem;
  private mantleSystem!: MantleSystem;
  private movementSystem!: MovementSystem;
  private jumpSystem!: JumpSystem;
  private swingSystem!: SwingSystem;
  private dodgeSystem!: DodgeSystem;
  private grappleSystem!: GrappleSystem;

  constructor() {
    super();
  }

  public async load(data: ArcaneKnightControllerComponentDataType): Promise<void> {
    // 1. Componente físico requerido
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('ArcaneKnightControllerComponent: CapsuleColliderComponent no encontrado.');
      return;
    }

    // 2. Sistemas
    this.combatSystem = new CombatSystem(data);
    this.throwSystem = new ThrowSystem(data);
    this.mantleSystem = new MantleSystem(this, data);
    this.movementSystem = new MovementSystem(
      this,
      null,
      data as unknown as CharacterControllerComponentDataType,
    );
    this.jumpSystem = new JumpSystem(
      this,
      null,
      data as unknown as CharacterControllerComponentDataType,
    );
    this.swingSystem = new SwingSystem(
      this,
      null,
      data as unknown as CharacterControllerComponentDataType,
    );
    this.dodgeSystem = new DodgeSystem(this, data);
    this.grappleSystem = new GrappleSystem(this, data);
    this.daggerHUD = new DaggerHUDSystem();

    // Registrar callback de grapple en ThrowSystem
    this.throwSystem.setGrappleCallback((hitPoint) => {
      this.grappleSystem.startGrapple(hitPoint);
    });

    // 3. Controlador cinemático de Rapier
    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public update(deltaTime: number): void {
    if (!this.isActive) return;

    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    this.updateGroundedState();
    this.mantleSystem.update();
    this.dodgeSystem.update(deltaTime);
    this.throwSystem.update(deltaTime, this.camera);
    this.daggerHUD.update(this.throwSystem);

    switch (this.movementState) {
      case CharacterMovementState.MANTLING:
        const mantleMovement = this.mantleSystem.updateMantleDirection();
        this.applyMovement(mantleMovement, deltaTime);
        break;

      case CharacterMovementState.DODGING: {
        const dodgeVel = this.dodgeSystem.getDodgeVelocity();
        const dodgeWithGravity = vec3.fromValues(
          dodgeVel[0],
          this.currentVerticalVelocity,
          dodgeVel[2],
        );
        this.applyMovement(dodgeWithGravity, deltaTime);
        break;
      }

      case CharacterMovementState.GRAPPLING: {
        const active = this.grappleSystem.update(deltaTime);
        if (active) {
          const grappleVel = this.grappleSystem.getGrappleVelocity();
          this.applyMovement(grappleVel, deltaTime);
        }
        break;
      }

      case CharacterMovementState.SWINGING:
        this.swingSystem.updateSwingMovement(deltaTime);
        const swingVelocity = this.mergeMovements();
        this.applyMovement(swingVelocity, deltaTime);
        break;

      case CharacterMovementState.IDLE:
      default:
        const inputDir = this.getInputVector();
        const targetMovement = this.getTargetMovement(inputDir);
        this.movementSystem.update(deltaTime, targetMovement);
        this.jumpSystem.update(deltaTime);
        const finalVelocity = this.mergeMovements();
        this.applyMovement(finalVelocity, deltaTime);
        break;
    }
  }

  public override setActive(active: boolean): void {
    this.isActive = active;
  }

  public getIsMantling(): boolean {
    return this.movementState === CharacterMovementState.MANTLING;
  }

  public setIsMantling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.MANTLING : CharacterMovementState.IDLE;
  }

  public setIsJumping(value: boolean): void {
    this.isJumping = value;
  }

  public setHorizontalVelocity(v: vec3): void {
    vec3.copy(this.currentHorizontalVelocity, v);
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
  public setVerticalVelocity(v: number): void {
    this.currentVerticalVelocity = v;
  }

  public getHorizontalVelocity(): vec3 {
    return this.currentHorizontalVelocity;
  }

  // ── IMovementController ──────────────────────────────────────────────────
  public getIsJumping(): boolean {
    return this.isJumping;
  }

  public getBoostedSpeed(): number {
    return this.boostedSpeed;
  }
  public setBoostedSpeed(speed: number): void {
    this.boostedSpeed = speed;
  }

  public getIsWallRunning(): boolean {
    return false;
  }
  public setIsWallRunning(_value: boolean): void {}

  public getIsDodging(): boolean {
    return this.movementState === CharacterMovementState.DODGING;
  }
  public setIsDodging(value: boolean): void {
    this.movementState = value ? CharacterMovementState.DODGING : CharacterMovementState.IDLE;
  }

  public getIsGrappling(): boolean {
    return this.movementState === CharacterMovementState.GRAPPLING;
  }
  public setIsGrappling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.GRAPPLING : CharacterMovementState.IDLE;
  }

  public getIsDashing(): boolean {
    return false;
  }
  public setIsDashing(_value: boolean): void {}

  public getIsSwinging(): boolean {
    return this.movementState === CharacterMovementState.SWINGING;
  }
  public setIsSwinging(value: boolean): void {
    this.movementState = value ? CharacterMovementState.SWINGING : CharacterMovementState.IDLE;
  }

  public getIsRolling(): boolean {
    return false;
  }
  public setIsRolling(_value: boolean): void {}

  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0.0;
  }
  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }

  public getGroundNormal(): vec3 {
    return this.groundNormal;
  }

  public applyJumpFromSystem(): void {
    const jumpVel = this.jumpSystem.getJumpVelocity();
    this.jumpSystem.applyJump(jumpVel);
  }

  public getCombatSystem(): CombatSystem {
    return this.combatSystem;
  }

  public getThrowSystem(): ThrowSystem {
    return this.throwSystem;
  }

  public startSwing(data: SwingEntryData): void {
    this.swingSystem.startSwing(data);
  }

  public getCamera(): CameraComponent | null {
    return this.camera;
  }

  public getCollider(): CapsuleColliderComponent {
    return this.capsuleCollider;
  }

  public getTransform(): TransformComponent {
    return this.getOwner().getComponent('transform') as TransformComponent;
  }

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
      const isFloor = hit.normal.y > 0.1;

      if (isFloor) {
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

    if (input.isActionPressed(GameAction.MOVE_FORWARD)) {
      inputDir[2] -= 1;
    }
    if (input.isActionPressed(GameAction.MOVE_BACKWARD)) {
      inputDir[2] += 1;
    }
    if (input.isActionPressed(GameAction.MOVE_LEFT)) {
      inputDir[0] -= 1;
    }
    if (input.isActionPressed(GameAction.MOVE_RIGHT)) {
      inputDir[0] += 1;
    }

    if (vec3.length(inputDir) > 0.01) {
      vec3.normalize(inputDir, inputDir);
    }

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
      const projected = this.projectOnPlane(horizontal, this.groundNormal);
      targetMovement = projected;
    }

    if (vec3.length(targetMovement) > 0.01) {
      vec3.normalize(targetMovement, targetMovement);
    }

    return targetMovement;
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

    let correctedMovement = this.characterController.computedMovement();

    const newVel = {
      x: correctedMovement.x / dt,
      y: correctedMovement.y / dt,
      z: correctedMovement.z / dt,
    };
    this.capsuleCollider.getRigidBody().setLinvel(newVel, true);

    for (var i = 0; i < this.characterController.numComputedCollisions(); i++) {
      const collision = this.characterController.computedCollision(i);
      if (!collision || !collision.collider) continue;

      const rigidBody = collision.collider.parent();
      if (!rigidBody) continue;

      const type = rigidBody.bodyType();

      const isFloor = Math.abs(collision.normal1.y) > 0.1 && collision.normal1.y > 0.0;
      if (isFloor) {
        continue;
      }

      const collisionNormal = vec3.fromValues(
        collision.normal1.x,
        collision.normal1.y,
        collision.normal1.z,
      );

      if (type === RAPIER.RigidBodyType.Fixed) {
        const isCeiling = collisionNormal[1] < -0.7;
        const isWall = Math.abs(collisionNormal[1]) < 0.5;

        // Cancelar estados especiales al chocar con geometría
        if (
          this.movementState === CharacterMovementState.DASHING ||
          this.movementState === CharacterMovementState.ROLLING
        ) {
          this.movementState = CharacterMovementState.IDLE;
        }

        if (
          this.movementState !== CharacterMovementState.WALL_RUNNING &&
          this.movementState !== CharacterMovementState.MANTLING &&
          isWall
        ) {
          this.removeVelocityIntoWall(collisionNormal);
          this.boostedSpeed = 0.0;
        }
        if (isCeiling && this.currentVerticalVelocity > 0) {
          this.currentVerticalVelocity = 0;
          this.isJumping = false;
        }
      }
    }
  }

  private removeVelocityIntoWall(collisionNormal: vec3): void {
    const dot =
      this.currentHorizontalVelocity[0] * collisionNormal[0] +
      this.currentHorizontalVelocity[1] * collisionNormal[1] +
      this.currentHorizontalVelocity[2] * collisionNormal[2];

    if (dot < 0) {
      this.currentHorizontalVelocity[0] -= dot * collisionNormal[0];
      this.currentHorizontalVelocity[1] -= dot * collisionNormal[1];
      this.currentHorizontalVelocity[2] -= dot * collisionNormal[2];
    }
  }

  /** Interpolación lineal hacia target con paso máximo de step. */
  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  public renderDebug(): void {
    // TODO: visualizar estado de combate y abilities en el HUD de debug
  }

  public override dispose(): void {}
}
