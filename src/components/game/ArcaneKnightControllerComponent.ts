import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { BasePlayerController } from './BasePlayerController';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { GameAction } from '../../types/GameAction.enum';
import { AbilitySlot } from '../../types/AbilitySlot.enum';
import type { ArcaneKnightControllerComponentDataType } from '../../types/ArcaneKnightControllerComponentData.type';

import { CombatSystem } from './combat/CombatSystem';
import { AbilitySystem } from './abilities/AbilitySystem';

/**
 * ArcaneKnightControllerComponent — Controlador de jugador para gameplay de combate y magia.
 *
 * A diferencia de CharacterControllerComponent (enfocado en parkour), este
 * controlador gestiona:
 *  - Movimiento básico en primera persona (WASD + salto + gravedad)
 *  - CombatSystem: ataque ligero/pesado, bloqueo/parry, dash de combate
 *  - AbilitySystem: habilidades mágicas desbloqueables y equipables en slots Q/E/R
 *
 * Arquitectura:
 *  - Estado centralizado aquí (velocidades, grounded, cámara).
 *  - Lógica de combate delegada a CombatSystem.
 *  - Lógica de habilidades delegada a AbilitySystem.
 *  - Sistemas leen/escriben el estado a través de la API pública (getters/setters).
 *
 * Requiere en la misma entidad:
 *  - CapsuleColliderComponent
 *
 * Requiere como hijo de la entidad:
 *  - CameraComponent
 */
export class ArcaneKnightControllerComponent extends BasePlayerController {
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
  private currentVerticalVelocity: number = 0.0;
  private currentHorizontalVelocity: vec3 = vec3.create();

  // ──── Parámetros de movimiento ────
  private moveSpeed: number = 6.0;
  private maxSpeed: number = 10.0;
  private groundAcceleration: number = 30.0;
  private groundDeceleration: number = 18.0;
  private airControl: number = 0.5;
  private airDrag: number = 0.1;

  // ──── Parámetros de salto (física parabólica) ────
  private jumpVelocity: number = 0.0;
  private jumpGravity: number = 0.0;
  private fallGravity: number = 0.0;
  private coyoteTime: number = 0.12;
  private timeSinceGrounded: number = 0.0;
  private isJumping: boolean = false;

  // ============================================
  // SISTEMAS MODULARES
  // ============================================
  private combatSystem!: CombatSystem;
  private abilitySystem!: AbilitySystem;

  constructor() {
    super();
  }

  // ============================================
  // INICIALIZACIÓN
  // ============================================

  public async load(data: ArcaneKnightControllerComponentDataType): Promise<void> {
    // 1. Componente físico requerido
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error('ArcaneKnightControllerComponent: CapsuleColliderComponent no encontrado.');
      return;
    }

    // 2. Parámetros de movimiento
    this.moveSpeed = data.moveSpeed ?? this.moveSpeed;
    this.maxSpeed = data.maxSpeed ?? this.maxSpeed;
    this.groundAcceleration = data.groundAcceleration ?? this.groundAcceleration;
    this.groundDeceleration = data.groundDeceleration ?? this.groundDeceleration;
    this.airControl = data.airControl ?? this.airControl;
    this.airDrag = data.airDrag ?? this.airDrag;

    // 3. Física de salto parabólica (igual que CharacterControllerComponent)
    const jumpHeight = data.jumpHeight ?? 2.0;
    const timeToPeak = data.jumpTimeToPeak ?? 0.5;
    const timeToDescent = data.jumpTimeToDescent ?? 0.45;
    this.coyoteTime = data.coyoteTime ?? this.coyoteTime;

    this.jumpVelocity = (2.0 * jumpHeight) / timeToPeak;
    this.jumpGravity = (-2.0 * jumpHeight) / (timeToPeak * timeToPeak);
    this.fallGravity = (-2.0 * jumpHeight) / (timeToDescent * timeToDescent);

    // 4. Sistemas
    this.combatSystem = new CombatSystem(data);
    this.abilitySystem = new AbilitySystem();

    // 5. Controlador cinemático de Rapier
    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  // ============================================
  // UPDATE PRINCIPAL
  // ============================================

  public update(deltaTime: number): void {
    if (!this.isActive) return;

    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    this.updateGroundedState();
    this.updateMovement(deltaTime);
    this.updateJump(deltaTime);
    this.applyMovement(deltaTime);

    this.combatSystem.update(deltaTime);
    this.processAbilityInput();
    this.abilitySystem.update(deltaTime);
  }

  // ============================================
  // MOVIMIENTO
  // ============================================

  private updateMovement(dt: number): void {
    const inputDir = this.getInputVector();
    const targetMovement = this.getTargetMovementWorld(inputDir);
    const hasInput = vec3.length(targetMovement) > 0.01;

    if (this.isGrounded) {
      this.updateGroundMovement(dt, targetMovement, hasInput);
    } else {
      this.updateAirMovement(dt, targetMovement, hasInput);
    }
  }

  private updateGroundMovement(dt: number, target: vec3, hasInput: boolean): void {
    const currentSpeed = vec3.length(this.currentHorizontalVelocity);
    const targetSpeed = hasInput ? this.moveSpeed : 0.0;
    const accel = hasInput ? this.groundAcceleration : this.groundDeceleration;
    const newSpeed = this.approach(currentSpeed, targetSpeed, accel * dt);
    vec3.scale(
      this.currentHorizontalVelocity,
      hasInput ? target : this.normalizeOrZero(this.currentHorizontalVelocity),
      newSpeed,
    );
  }

  private updateAirMovement(dt: number, target: vec3, hasInput: boolean): void {
    if (hasInput) {
      const desired = vec3.scale(vec3.create(), target, this.moveSpeed);
      const airAccel = this.groundAcceleration * this.airControl;
      const diff = vec3.sub(vec3.create(), desired, this.currentHorizontalVelocity);
      const step = vec3.scale(vec3.create(), diff, Math.min(1.0, airAccel * dt));
      vec3.add(this.currentHorizontalVelocity, this.currentHorizontalVelocity, step);
    } else {
      const drag = Math.max(0.0, 1.0 - this.airDrag * dt);
      vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, drag);
    }

    // Clamp velocidad horizontal en el aire
    const speed = vec3.length(this.currentHorizontalVelocity);
    if (speed > this.maxSpeed) {
      vec3.scale(
        this.currentHorizontalVelocity,
        this.currentHorizontalVelocity,
        this.maxSpeed / speed,
      );
    }
  }

  private updateJump(dt: number): void {
    // Coyote time
    if (this.isGrounded) {
      this.timeSinceGrounded = 0.0;
      if (this.currentVerticalVelocity < 0) {
        this.currentVerticalVelocity = 0.0;
        this.isJumping = false;
      }
    } else {
      this.timeSinceGrounded += dt;
    }

    // Input de salto
    const input = Engine.getInput();
    const canJump = this.isGrounded || this.timeSinceGrounded < this.coyoteTime;
    if (input.isActionJustPressed(GameAction.JUMP) && canJump && !this.isJumping) {
      this.currentVerticalVelocity = this.jumpVelocity;
      this.isJumping = true;
      this.timeSinceGrounded = this.coyoteTime; // consumir coyote
    }

    // Jump cut (soltar salto reduce velocidad ascendente)
    if (
      this.isJumping &&
      !input.isActionPressed(GameAction.JUMP) &&
      this.currentVerticalVelocity > 0
    ) {
      this.currentVerticalVelocity *= 0.7;
    }

    // Gravedad
    const gravity = this.currentVerticalVelocity > 0 ? this.jumpGravity : this.fallGravity;
    this.currentVerticalVelocity += gravity * dt;
  }

  private applyMovement(dt: number): void {
    const velocity = vec3.fromValues(
      this.currentHorizontalVelocity[0],
      this.currentVerticalVelocity,
      this.currentHorizontalVelocity[2],
    );

    const movement = vec3.scale(vec3.create(), velocity, dt);

    this.characterController.computeColliderMovement(
      this.capsuleCollider.getCollider(),
      new RAPIER.Vector3(movement[0], movement[1], movement[2]),
      QueryFilterFlags.EXCLUDE_SENSORS,
    );

    const corrected = this.characterController.computedMovement();
    this.capsuleCollider
      .getRigidBody()
      .setLinvel({ x: corrected.x / dt, y: corrected.y / dt, z: corrected.z / dt }, true);
  }

  // ============================================
  // HABILIDADES
  // ============================================

  private processAbilityInput(): void {
    const input = Engine.getInput();
    if (input.isActionJustPressed(GameAction.ABILITY_Q)) {
      this.abilitySystem.activateSlot(AbilitySlot.Q);
    }
    if (input.isActionJustPressed(GameAction.ABILITY_E)) {
      this.abilitySystem.activateSlot(AbilitySlot.E);
    }
    if (input.isActionJustPressed(GameAction.ABILITY_R)) {
      this.abilitySystem.activateSlot(AbilitySlot.R);
    }
  }

  // ============================================
  // API PÚBLICA
  // ============================================

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
    return this.maxSpeed;
  }
  public setVerticalVelocity(v: number): void {
    this.currentVerticalVelocity = v;
  }

  public getHorizontalVelocity(): vec3 {
    return this.currentHorizontalVelocity;
  }

  public getCombatSystem(): CombatSystem {
    return this.combatSystem;
  }

  public getAbilitySystem(): AbilitySystem {
    return this.abilitySystem;
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

  // ============================================
  // HELPERS INTERNOS
  // ============================================

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
    const hit = this.capsuleCollider.raycastGrounded(0.2);
    this.isGrounded = hit !== null;
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

  private getTargetMovementWorld(inputDir: vec3): vec3 {
    if (vec3.length(inputDir) < 0.01) return vec3.create();

    const cameraObj = this.camera!.getCamera();
    const forward = cameraObj.getFront();
    const up = vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), up, forward));

    const forwardXZ = vec3.normalize(vec3.create(), vec3.fromValues(forward[0], 0, forward[2]));
    const rightXZ = vec3.normalize(vec3.create(), vec3.fromValues(right[0], 0, right[2]));

    const fwd = vec3.scale(vec3.create(), forwardXZ, -inputDir[2]);
    const rgt = vec3.scale(vec3.create(), rightXZ, -inputDir[0]);
    const result = vec3.add(vec3.create(), fwd, rgt);

    if (vec3.length(result) > 0.01) vec3.normalize(result, result);
    return result;
  }

  /** Interpolación lineal hacia target con paso máximo de step. */
  private approach(current: number, target: number, step: number): number {
    if (current < target) return Math.min(current + step, target);
    return Math.max(current - step, target);
  }

  private normalizeOrZero(v: vec3): vec3 {
    const len = vec3.length(v);
    if (len < 0.001) return vec3.create();
    return vec3.scale(vec3.create(), v, 1.0 / len);
  }

  // ============================================
  // CICLO DE VIDA
  // ============================================

  public renderDebug(): void {
    // TODO: visualizar estado de combate y abilities en el HUD de debug
  }

  public override dispose(): void {
    this.abilitySystem.dispose();
  }
}
