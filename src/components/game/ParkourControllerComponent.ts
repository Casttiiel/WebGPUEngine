/*import { vec3 } from 'gl-matrix';
import { BasePlayerController } from './BasePlayerController';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { SwingEntryData } from '../../types/SwingEntryData.type';
import { GameAction } from '../../types/GameAction.enum';
import { CharacterMovementState } from '../../types/CharacterMovementState.enum';

// Import sistemas modulares
import { MovementSystem } from './movement/MovementSystem';
import { JumpSystem } from './movement/JumpSystem';
import { RollSystem } from './movement/RollSystem';
import { WallRunSystem } from './movement/WallRunSystem';
import { DashSystem } from './movement/DashSystem';
import { MantleSystem } from './movement/MantleSystem';
import { IMantleController } from './movement/IMantleController';
import { IMovementController } from './movement/IMovementController';
import { SwingSystem } from './movement/SwingSystem';
import { PlayerModifiersComponent } from './PlayerModifiersComponent';

/**
 * ParkourControllerComponent - FPS Character Controller (Refactorizado)
 *
 * ARQUITECTURA MODULAR:
 * - Estado centralizado en este componente
 * - Lógica específica delegada a sistemas especializados
 * - Acceso controlado mediante getters/setters
 *
 * Funcionalidades:
 * - Movimiento WASD relativo a la cámara (primera persona)
 * - Sistema de salto variable con gravedad ajustable
 * - Wall running y wall jumping
 * - Roll con conversión de velocidad vertical
 * - Dash hacia puntos específicos
 * - Mantling (trepar)
 * - Swing en barras
 *
 * Requiere:
 * - CapsuleColliderComponent en la misma entidad
 * - CameraComponent como hijo de la entidad
 */ /*
export class ParkourControllerComponent
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
  // ESTADO COMPARTIDO (accesible por sistemas)
  // ============================================
  // Flags independientes
  private isActive: boolean = true;
  private isGrounded: boolean = false;
  private isJumping: boolean = false;

  // Estado de movimiento (mutuamente exclusivo)
  private movementState: CharacterMovementState = CharacterMovementState.IDLE;

  private currentVerticalVelocity: number = 0.0;
  private currentHorizontalVelocity: vec3 = vec3.create();
  private boostedSpeed: number = 0.0;
  private inputDisableTimer: number = -10.0;
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0);

  // ============================================
  // SISTEMAS MODULARES
  // ============================================
  private movementSystem!: MovementSystem;
  private jumpSystem!: JumpSystem;
  private rollSystem!: RollSystem;
  private wallRunSystem!: WallRunSystem;
  private dashSystem!: DashSystem;
  private mantleSystem!: MantleSystem;
  private swingSystem!: SwingSystem;
  private modifiers: PlayerModifiersComponent | null = null;

  // ============================================
  // PARÁMETROS (PARA IMPULSE PADS)
  // ============================================
  private impulsePadInputDisableTime: number = 0.5;

  constructor() {
    super();
  }

  // ============================================
  // UPDATE PRINCIPAL (ORQUESTACIÓN)
  // ============================================
  public update(deltaTime: number): void {
    if (!this.isActive) return;
    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    // Actualizar input disable timer
    if (this.inputDisableTimer > 0.0) {
      this.inputDisableTimer -= deltaTime;
    }

    // Actualizar estado del suelo
    this.updateGroundedState();

    /*console.log(
      'grounded',
      this.isGrounded,
      'state',
      this.movementState,
      'jumping',
      this.isJumping,
    );*/
/*
    // Detectar paredes para wallrun
    this.wallRunSystem.detectWall(deltaTime);

    // Actualizar sistemas de manejo (no ejecutan movimiento, solo detectan)
    //this.dashSystem.update();
    this.mantleSystem.update();
    //this.rollSystem.update(deltaTime);

    // Ejecutar sistema de movimiento activo según el estado
    switch (this.movementState) {
      case CharacterMovementState.DASHING:
        const dashMovement = this.dashSystem.updateDashMovement();
        this.applyMovement(dashMovement, deltaTime);
        break;

      case CharacterMovementState.MANTLING:
        const mantleMovement = this.mantleSystem.updateMantleDirection();
        this.applyMovement(mantleMovement, deltaTime);
        break;

      case CharacterMovementState.WALL_RUNNING:
        const inputDirWall = this.getInputVector();
        const targetMovementWall = this.getTargetMovement(inputDirWall);
        this.wallRunSystem.update(deltaTime, targetMovementWall);
        this.jumpSystem.update(deltaTime);
        const wallRunVelocity = this.mergeMovements();
        this.applyMovement(wallRunVelocity, deltaTime);
        break;

      case CharacterMovementState.ROLLING:
        const rollVelocity = this.rollSystem.updateRollMovement(deltaTime);
        this.applyMovement(rollVelocity, deltaTime);
        break;

      case CharacterMovementState.SWINGING:
        this.swingSystem.updateSwingMovement(deltaTime);
        const swingVelocity = this.mergeMovements();
        this.applyMovement(swingVelocity, deltaTime);
        break;

      case CharacterMovementState.IDLE:
      default:
        // Movimiento normal
        const inputDir = this.getInputVector();
        const targetMovement = this.getTargetMovement(inputDir);
        this.movementSystem.update(deltaTime, targetMovement);
        this.jumpSystem.update(deltaTime);
        // Coyote time de wall jump: permite saltar brevemente después de dejar la pared
        if (!this.isGrounded) {
          this.wallRunSystem.checkCoyoteWallJump(deltaTime);
        }
        const finalVelocity = this.mergeMovements();
        this.applyMovement(finalVelocity, deltaTime);
        break;
    }
  }

  // ============================================
  // GETTERS/SETTERS - API PÚBLICA PARA SISTEMAS
  // ============================================

  // Velocidades
  public override getVerticalVelocity(): number {
    return this.currentVerticalVelocity;
  }
  public setVerticalVelocity(v: number): void {
    this.currentVerticalVelocity = v;
  }

  public getHorizontalVelocity(): vec3 {
    return this.currentHorizontalVelocity;
  }
  public setHorizontalVelocity(v: vec3): void {
    vec3.copy(this.currentHorizontalVelocity, v);
  }

  public override getCurrentSpeed(): number {
    return vec3.length(this.currentHorizontalVelocity);
  }

  public getBoostedSpeed(): number {
    return this.boostedSpeed;
  }
  public setBoostedSpeed(speed: number): void {
    this.boostedSpeed = speed;
  }

  // Estados (flags)
  public override getIsGrounded(): boolean {
    return this.isGrounded;
  }

  public getIsJumping(): boolean {
    return this.isJumping;
  }
  public setIsJumping(value: boolean): void {
    this.isJumping = value;
  }

  // Estado de movimiento (enum)
  public getMovementState(): CharacterMovementState {
    return this.movementState;
  }
  public setMovementState(state: CharacterMovementState): void {
    this.movementState = state;
  }

  // Helpers de conveniencia para estados específicos
  public getIsRolling(): boolean {
    return this.movementState === CharacterMovementState.ROLLING;
  }
  public setIsRolling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.ROLLING : CharacterMovementState.IDLE;
  }

  public getIsWallRunning(): boolean {
    return this.movementState === CharacterMovementState.WALL_RUNNING;
  }
  public setIsWallRunning(value: boolean): void {
    this.movementState = value ? CharacterMovementState.WALL_RUNNING : CharacterMovementState.IDLE;
  }

  public getIsDashing(): boolean {
    return this.movementState === CharacterMovementState.DASHING;
  }
  public setIsDashing(value: boolean): void {
    this.movementState = value ? CharacterMovementState.DASHING : CharacterMovementState.IDLE;
  }
  public getIsDodging(): boolean {
    return false;
  }
  public setIsDodging(_value: boolean): void {}
  public getIsGrappling(): boolean {
    return false;
  }
  public setIsGrappling(_value: boolean): void {}
  public getIsMantling(): boolean {
    return this.movementState === CharacterMovementState.MANTLING;
  }

  public setIsMantling(value: boolean): void {
    this.movementState = value ? CharacterMovementState.MANTLING : CharacterMovementState.IDLE;
  }

  // ParkourController no usa vault pero debe satisfacer la interfaz
  public getIsVaulting(): boolean {
    return this.movementState === CharacterMovementState.VAULTING;
  }
  public setIsVaulting(value: boolean): void {
    this.movementState = value ? CharacterMovementState.VAULTING : CharacterMovementState.IDLE;
  }

  public getIsSwinging(): boolean {
    return this.movementState === CharacterMovementState.SWINGING;
  }
  public setIsSwinging(value: boolean): void {
    this.movementState = value ? CharacterMovementState.SWINGING : CharacterMovementState.IDLE;
  }

  // Input control
  public getInputDisableTimer(): number {
    return this.inputDisableTimer;
  }
  public setInputDisableTimer(time: number): void {
    this.inputDisableTimer = time;
  }
  public isInputDisabled(): boolean {
    return this.inputDisableTimer > 0.0;
  }

  // Referencias físicas
  public getCollider(): CapsuleColliderComponent {
    return this.capsuleCollider;
  }
  public getCamera(): CameraComponent | null {
    return this.camera;
  }
  public getGroundNormal(): vec3 {
    return this.groundNormal;
  }

  // Método público para que WallRunSystem pueda aplicar jump
  public applyJumpFromSystem(): void {
    const jumpVel = this.jumpSystem.getJumpVelocity();
    this.jumpSystem.applyJump(jumpVel);
  }

  // ============================================
  // LÓGICA COMPARTIDA (USADA POR MÚLTIPLES SISTEMAS)
  // ============================================

  private updateGroundedState(): void {
    const snapDistance = 0.2;
    const hit = this.capsuleCollider.raycastGrounded(snapDistance);
    this.isGrounded = hit !== null;

    if (this.isGrounded && hit) {
      this.dashSystem.onGrounded();
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

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  private findCamera(): void {
    if (!this.cameraFound) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        const cam = child.getComponent('camera') as CameraComponent;
        if (cam) {
          this.camera = cam;
          this.cameraFound = true;
          break;
        }
      }

      if (!this.camera) {
        console.warn('ParkourControllerComponent: No camera found in children.');
      }
    }
  }

  // ============================================
  // API PÚBLICA (PARA OTROS COMPONENTES)
  // ============================================

  public applyImpulseFromPad(impulse: vec3): void {
    const force = impulse;
    const horizontal = vec3.fromValues(force[0], 0, force[2]);
    this.jumpSystem.applyJump(force[1]);
    this.currentHorizontalVelocity = vec3.clone(horizontal);
    this.inputDisableTimer = this.impulsePadInputDisableTime;
  }

  public startSwing(data: SwingEntryData): void {
    this.swingSystem.startSwing(data);
  }

  public setActive(active: boolean): void {
    this.isActive = active;
  }

  public getWallNormal() {
    return this.wallRunSystem.getWallNormal();
  }

  public override getMaxSpeed(): number {
    return this.movementSystem.getMaxSpeed();
  }

  public getRollTimer(): number {
    return this.rollSystem.getRollTimer();
  }

  public getRollDuration(): number {
    return this.rollSystem.getRollDuration();
  }

  // ============================================
  // DEBUG Y UTILIDADES
  // ============================================

  public override renderInMenu(): void {
    alert("ParkourControllerComponent doesn't support in-menu editing yet.");
  }

  public renderDebug(): void {
    // TODO: Render debug info
  }

  public override dispose(): void {
    // Cleanup if needed
  }

  // ============================================
  // INICIALIZACIÓN (LOAD)
  // ============================================

  public async load(data: CharacterControllerComponentDataType): Promise<void> {
    // 1. Inicializar física y referencias básicas
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error(
        'ParkourControllerComponent requires CapsuleColliderComponent on the same entity!',
      );
      return;
    }

    // 2. Buscar componente de modifiers (opcional)
    this.modifiers = this.getOwner().getComponent('player_modifiers') as PlayerModifiersComponent;

    this.impulsePadInputDisableTime =
      data.impulsePadInputDisableTime ?? this.impulsePadInputDisableTime;

    // 3. Crear sub-sistemas pasándoles referencia al controller
    this.movementSystem = new MovementSystem(this, this.modifiers, data);
    this.jumpSystem = new JumpSystem(this, this.modifiers, data);
    this.rollSystem = new RollSystem(this, this.modifiers);
    this.wallRunSystem = new WallRunSystem(this, this.modifiers, data);
    this.dashSystem = new DashSystem(this, this.modifiers);
    this.mantleSystem = new MantleSystem(this, data);
    this.swingSystem = new SwingSystem(this, this.modifiers, data);

    // 4. Crear character controller de Rapier
    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }
}
*/

// Stub — class is temporarily disabled.
export class ParkourControllerComponent {
  getCurrentSpeed(): number {
    return 0;
  }
  getIsGrounded(): boolean {
    return false;
  }
}
// HeadBobComponent imports it under the old alias.
export { ParkourControllerComponent as CharacterControllerComponent };
