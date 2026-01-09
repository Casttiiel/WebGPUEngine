import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { GameAction } from '../../types/GameAction.enum';
import { SwingEntryData } from '../../types/SwingEntryData.type';
import { CollisionGroups } from '../../types/CollisionGroups.enum';

/**
 * CharacterControllerComponent - FPS Character Controller
 *
 * Funcionalidades:
 * - Movimiento WASD relativo a la cámara (primera persona)
 * - Gravedad automática (Dynamic RigidBody)
 * - Grounded check con raycast
 * - Salto
 *
 * Requiere:
 * - CapsuleColliderComponent en la misma entidad
 * - CameraComponent como hijo de la entidad
 */
export class CharacterControllerComponent extends Component {
  // Referencias
  private capsuleCollider!: CapsuleColliderComponent;
  private characterController!: RAPIER.KinematicCharacterController;
  private camera: CameraComponent | null = null;
  private cameraFound: boolean = false;

  // Estado
  private isActive: boolean = true;
  private isGrounded: boolean = false;
  private isJumping: boolean = false;
  private isWallRunning: boolean = false;
  private isMantling: boolean = false;
  private isSwinging: boolean = false;
  private isRolling: boolean = false;
  private isDashing: boolean = false;
  private isNearWall: boolean = false;
  private currentVerticalVelocity: number = 0.0;
  private currentHorizontalVelocity: vec3 = vec3.create();
  private inputDisableTimer: number = -10.0;
  private originalHeight: number = 0.0; // Altura original del collider
  private originalRadius: number = 0.0; // Radio original del collider
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0); // Normal del suelo actual

  // Movement
  private runSpeed: number = 9.0; // Velocidad base (sin flow)
  private maxSpeed: number = 14.0; // Velocidad máxima con buffs
  private groundAcceleration: number = 36.0;
  private groundDeceleration: number = 18.0;
  private airControl: number = 0.65;
  private airDrag: number = 0.1;

  // Jump
  private jumpHeight: number = 2.2;
  private jumpTimeToPeak: number = 0.5;
  private jumpTimeToDescent: number = 0.4;
  private jumpVelocity: number = 0.0;
  private jumpGravity: number = 0.0;
  private fallGravity: number = 0.0;
  private jumpCutFactor: number = 0.7; // Factor para reducir la velocidad al soltar la tecla de salto (0.0 = cortar totalmente, 1.0 = no cortar)
  private coyoteTime: number = 0.12; // Segundos de gracia después de dejar el suelo
  private timeSinceGrounded: number = 0.0; // Tiempo desde que dejó de estar grounded
  private jumpCutVerticalVelocityLimit: number = 0.25; // Velocidad vertical máxima para aplicar el corte de salto

  // WallRun
  private wallNormal: vec3 = vec3.create();
  private minWallRunSpeed: number = 7.0; // Velocidad mínima para iniciar wall run
  private initialDragFactorDuringWallRun: number = 0.85; // Factor de reducción de velocidad al iniciar wall run
  private wallRunGravity: number = -4.0; // caída lenta
  private detectWallDistance: number = 0.7; // Distancia para detectar paredes
  private wallRunMaxEntryAngle: number = 0.9; // Ángulo máximo (coseno) para iniciar wall run
  private wallDrag: number = 0.05; // Resistencia al movimiento durante wall run
  private maxWallRunDuration: number = 2.5; // Duración máxima del wall run en segundos
  private currentWallRunTime: number = 0.0; // Tiempo actual del wall run

  // WallJump
  private disableInputAfterWallJumpTime: number = 0.3; // Tiempo que se deshabilita el input tras un wall jump

  // Mantling (trepar)
  private mantleDetectionDistance: number = 1.5; // Distancia para detectar obstáculos
  private mantleMaxHeight: number = -0.025; // Altura máxima que puede trepar relativa a la camara
  private mantleTargetPos: vec3 = vec3.create(); // Posición objetivo del mantle
  private mantleStoredVelocity: number = 0.0;
  private minMantleVelocity: number = 9.0; // Velocidad mínima al iniciar mantle
  private mantlingMinVerticalVelocity: number = -5.0; // Velocidad vertical mínima para permitir mantle

  // Dash
  private dashDetectionDistance: number = 8.0; // Distancia máxima para detectar punto de dash
  private dashSpeed: number = 50.0; // Velocidad del dash
  private dashStopDistance: number = 0.5; // Distancia al objetivo para detener el dash
  private dashTargetPos: vec3 = vec3.create();
  private canDash: boolean = true; // Si puede usar el dash (se recarga al tocar el suelo)

  //Impulse Pads
  private impulsePadInputDisableTime: number = 0.5; // Tiempo para deshabilitar input tras un impulso

  // Swing Bar
  private swingAxis: vec3 = vec3.create();
  private swingBase: vec3 = vec3.create(); // dirección "abajo" del arco
  private swingTangent: vec3 = vec3.create(); // eje tangencial
  private swingRadius: number = 0;
  private swingAngle: number = 0;
  private swingSpeed: number = 0;
  private minSwingSpeed: number = 6.0;
  private swingAngularSpeed: number = 0;
  private swingEndAngle: number = 0;
  private swingDirection: number = 1;

  // Roll
  private rollDuration: number = 0.4; // Duración fija del roll en segundos
  private rollSpeedMultiplier: number = 1.9; // Multiplicador de velocidad durante el roll (40% más rápido)
  private rollMinStartSpeed: number = 0.01; // Velocidad mínima para activar el roll
  private rollSpeed: number = 0.0; // Velocidad del roll (capturada al inicio)
  private rollDirection: vec3 = vec3.create(); // Dirección fija del roll
  private rollTimer: number = 0.0; // Tiempo transcurrido en el roll
  private rollCooldown: number = 0.5; // Tiempo de espera entre rolls (en segundos)
  private rollCooldownTimer: number = 0.0; // Temporizador del cooldown
  private rollJumpWindowTime: number = 0.25; // Ventana de tiempo para salto especial después del roll
  private timeSinceLastRoll: number = 999.0; // Tiempo desde que terminó el último roll
  private rollJumpVerticalForce: number = 6.0; // Fuerza vertical del salto especial (mayor que salto normal)
  private rollJumpHorizontalBoost: number = 15.0; // Impulso horizontal del salto especial
  private initialRollSpeed: number = 0.0;

  constructor() {
    super();
  }

  public update(deltaTime: number): void {
    if (!this.isActive) return;
    this.findCamera();
    if (!this.capsuleCollider || !this.camera) return;

    if (this.inputDisableTimer > 0.0) {
      this.inputDisableTimer -= deltaTime;
    }

    this.getIsGrounded();
    this.manageDashing();
    this.manageMantling();
    this.detectWall();
    this.manageRolling(deltaTime);

    console.log(vec3.length(this.currentHorizontalVelocity));

    if (this.isDashing) {
      const targetMovement = this.manageDashMovement();
      this.applyMovement(targetMovement, deltaTime);
    } else if (this.isMantling) {
      const targetMovement = this.manageMantleDirection();
      this.applyMovement(targetMovement, deltaTime);
    } else if (this.isWallRunning) {
      this.updateWallRun(deltaTime);
      const inputDir = this.getInputVector();
      const targetMovement = this.getTargetMovement(inputDir);
      this.manageHorizontalMovementForWallRun(deltaTime, targetMovement);
      this.manageVerticalMovement(deltaTime);
      const finalVelocity = this.mergeMovements();
      this.applyMovement(finalVelocity, deltaTime);
    } else if (this.isRolling) {
      const finalVelocity = this.manageRollMovement(deltaTime);
      this.applyMovement(finalVelocity, deltaTime);
    } else if (this.isSwinging) {
      this.manageSwingMovement(deltaTime);
      const finalVelocity = this.mergeMovements();
      this.applyMovement(finalVelocity, deltaTime);
    } else {
      const inputDir = this.getInputVector();
      const targetMovement = this.getTargetMovement(inputDir);
      this.manageHorizontalMovement(deltaTime, targetMovement);
      this.manageVerticalMovement(deltaTime);
      const finalVelocity = this.mergeMovements();
      this.applyMovement(finalVelocity, deltaTime);
    }
  }

  //MOVEMENT
  private getIsGrounded(): void {
    const snapDistance = 0.2; // Distancia extra para snap-to-ground

    // Raycast más largo para detectar suelo en rampas rápidas
    const hit = this.capsuleCollider.raycastGrounded(snapDistance);
    this.isGrounded = hit !== null;

    if (this.isGrounded) {
      this.canDash = true;
      const isFloor = hit.normal.y > 0.1;

      // Si es suelo → ignorar completamente para lógica de pared
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
      inputDir[2] -= 1; // Forward
    }
    if (input.isActionPressed(GameAction.MOVE_BACKWARD)) {
      inputDir[2] += 1; // Backward
    }
    if (input.isActionPressed(GameAction.MOVE_LEFT)) {
      inputDir[0] -= 1; // Left
    }
    if (input.isActionPressed(GameAction.MOVE_RIGHT)) {
      inputDir[0] += 1; // Right
    }

    // Normalize input direction
    if (vec3.length(inputDir) > 0.01) {
      vec3.normalize(inputDir, inputDir);
    }

    return inputDir;
  }

  private getTargetMovement(inputDir: vec3): vec3 {
    let targetMovement = vec3.create();

    const cameraObj = this.camera!.getCamera();
    const forward = cameraObj.getFront();
    const up = vec3.fromValues(0, 1, 0); // World up

    // Calculate right vector: right = up × forward (right-handed system)
    const right = vec3.cross(vec3.create(), up, forward);
    vec3.normalize(right, right);

    // Project forward and right onto XZ plane (ignore Y for horizontal movement)
    const forwardXZ = vec3.fromValues(forward[0], 0, forward[2]);
    const rightXZ = vec3.fromValues(right[0], 0, right[2]);

    vec3.normalize(forwardXZ, forwardXZ);
    vec3.normalize(rightXZ, rightXZ);

    // Combine input with camera directions
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

    // Normalize final movement
    if (vec3.length(targetMovement) > 0.01) {
      vec3.normalize(targetMovement, targetMovement);
    }

    return targetMovement;
  }

  private manageHorizontalMovement(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;

    if (this.isGrounded) {
      // EN SUELO: Control normal con aceleración/frenado suave
      if (!hasInput) {
        targetMovement = vec3.normalize(vec3.create(), this.currentHorizontalVelocity);
      }
      const currentSpeed = vec3.length(this.currentHorizontalVelocity);
      const targetSpeed = hasInput ? this.runSpeed : 0.0;
      const accel = hasInput ? this.groundAcceleration : this.groundDeceleration;
      const newSpeed = this.approach(currentSpeed, targetSpeed, accel * deltaTime);

      vec3.scale(this.currentHorizontalVelocity, targetMovement, newSpeed);
    } else {
      // EN AIRE: Aceleración directa hacia velocidad objetivo
      if (hasInput) {
        // Velocidad objetivo en la dirección de input
        vec3.scale(targetMovement, targetMovement, this.runSpeed);

        const disabler = this.inputDisableTimer > 0.0 ? 0.25 : 1.0;

        const airAcceleration = this.groundAcceleration * this.airControl * disabler;

        // Interpolar componentes X y Z hacia velocidad objetivo
        this.currentHorizontalVelocity[0] = this.approach(
          this.currentHorizontalVelocity[0],
          targetMovement[0],
          airAcceleration * deltaTime,
        );
        this.currentHorizontalVelocity[2] = this.approach(
          this.currentHorizontalVelocity[2],
          targetMovement[2],
          airAcceleration * deltaTime,
        );
      } else {
        // Sin input: aplicar resistencia del aire
        const dragFactor = Math.pow(1.0 - this.airDrag, deltaTime);
        vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, dragFactor);
      }
    }
  }

  private manageVerticalMovement(deltaTime: number): void {
    this.applyGravity(deltaTime);
    this.manageJump(deltaTime);
  }

  private applyGravity(deltaTime: number): void {
    if (!this.isGrounded) {
      const gravity = this.currentVerticalVelocity > 0 ? this.jumpGravity : this.fallGravity;
      const finalGravity =
        this.isWallRunning && this.currentVerticalVelocity < 0.0 ? this.wallRunGravity : gravity;
      const jumpCutFactor =
        this.isJumping &&
        !this.isWallRunning &&
        Math.abs(this.currentVerticalVelocity) > 0 &&
        Math.abs(this.currentVerticalVelocity) < this.jumpCutVerticalVelocityLimit
          ? this.jumpCutFactor
          : 1.0;

      this.currentVerticalVelocity += finalGravity * jumpCutFactor * deltaTime;
    } else if (this.isGrounded && !this.isJumping) {
      this.currentVerticalVelocity = 0.0;
    }
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

    // Aplicar movimiento real
    const newVel = {
      x: correctedMovement.x / dt,
      y: correctedMovement.y / dt,
      z: correctedMovement.z / dt,
    };
    this.capsuleCollider.getRigidBody().setLinvel(newVel, true);
    for (var i = 0; i < this.characterController.numComputedCollisions(); i++) {
      const collision = this.characterController.computedCollision(i);
      const rigidBody = collision.collider.parent();
      const type = rigidBody.bodyType();

      // Detectar si es suelo
      const isFloor = Math.abs(collision.normal1.y) > 0.1 && collision.normal1.y > 0.0;
      // Si es suelo → ignorar completamente para lógica de pared
      if (isFloor) {
        continue;
      }

      const collisionNormal = vec3.fromValues(
        collision.normal1.x,
        collision.normal1.y,
        collision.normal1.z,
      );

      if (type === RAPIER.RigidBodyType.Fixed) {
        // Detectar colisión con pared (no suelo, no techo)
        const isCeiling = collisionNormal[1] < -0.7;
        const isWall = Math.abs(collisionNormal[1]) < 0.5; // Normal mayormente horizontal

        this.isDashing = false;
        this.isRolling = false;

        if (!this.isWallRunning && !this.isMantling && isWall) {
          this.removeVelocityIntoWall(collisionNormal);
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
    // si el vector apunta hacia la pared (dot < 0):
    if (dot < 0) {
      this.currentHorizontalVelocity[0] -= dot * collisionNormal[0];
      this.currentHorizontalVelocity[1] -= dot * collisionNormal[1];
      this.currentHorizontalVelocity[2] -= dot * collisionNormal[2];
    }
  }

  //JUMP
  private manageJump(deltaTime: number): void {
    const input = Engine.getInput();
    const canGroundJump =
      !this.isJumping && (this.timeSinceGrounded <= this.coyoteTime || this.isGrounded);

    // Update coyote time
    if (this.isGrounded && !this.isJumping) {
      this.timeSinceGrounded = 0.0;
    } else {
      this.timeSinceGrounded += deltaTime;
    }

    // Detectar inicio del salto
    if (input.isActionBuffered(GameAction.JUMP) && canGroundJump) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.applyJump(this.jumpVelocity);
    } else if (
      this.isJumping &&
      Math.abs(this.currentVerticalVelocity) > this.jumpCutVerticalVelocityLimit &&
      this.currentVerticalVelocity < 0.0
    ) {
      this.isJumping = false;
    }
  }

  private applyJump(jumpForce: number): void {
    this.currentVerticalVelocity = jumpForce;
    this.isJumping = true; // Iniciar salto variable
    this.timeSinceGrounded = this.coyoteTime + 1.0; // Invalidar coyote time después del salto
  }

  //ROLLING
  private manageRolling(deltaTime: number): void {
    const input = Engine.getInput();

    if (this.rollCooldownTimer > 0.0) {
      this.rollCooldownTimer -= deltaTime;
    }

    this.timeSinceLastRoll += deltaTime;

    if (
      !this.isRolling &&
      this.isGrounded &&
      this.rollCooldownTimer <= 0.0 &&
      input.isActionBuffered(GameAction.ROLL)
    ) {
      input.consumeBufferedAction(GameAction.ROLL);
      this.startRoll();
    }
  }

  private startRoll(): void {
    this.isRolling = true;
    this.rollTimer = 0.0;

    // Capturar velocidad actual
    const currentSpeed = vec3.length(this.currentHorizontalVelocity);

    this.initialRollSpeed = Math.max(currentSpeed, this.runSpeed);
    this.rollSpeed = this.initialRollSpeed * this.rollSpeedMultiplier;

    // Fijar dirección del roll
    // Si estás parado, usar la dirección de la cámara (forward)
    if (currentSpeed <= this.rollMinStartSpeed) {
      const cameraObj = this.camera!.getCamera();
      const forward = cameraObj.getFront();
      // Proyectar forward en el plano horizontal (XZ) y normalizar
      this.rollDirection[0] = forward[0];
      this.rollDirection[1] = 0;
      this.rollDirection[2] = forward[2];

      vec3.normalize(this.rollDirection, this.rollDirection);
    } else {
      // Si te mueves, usar la dirección actual del movimiento
      vec3.normalize(this.rollDirection, this.currentHorizontalVelocity);
    }
  }

  private manageRollMovement(deltaTime: number): vec3 {
    this.rollTimer += deltaTime;

    // Proyectar la dirección fija del roll sobre el plano del suelo
    const projected = this.projectOnPlane(this.rollDirection, this.groundNormal);
    vec3.normalize(projected, projected);

    // Mantener velocidad constante durante todo el roll (sin cambios)
    const result = vec3.scale(vec3.create(), this.rollDirection, this.rollSpeed);

    // Terminar roll cuando se acaba la duración O perdemos contacto con el suelo
    if (this.rollTimer >= this.rollDuration || !this.isGrounded) {
      this.endRoll();
    }

    return result;
  }

  private endRoll(): void {
    if (!this.isRolling) return;
    this.isRolling = false;
    this.rollTimer = 0.0;
    this.rollCooldownTimer = this.rollCooldown; // Iniciar cooldown
    this.timeSinceLastRoll = 0.0; // Marcar el momento en que terminó el roll

    // Transferir velocidad del roll al movimiento normal
    const dir = vec3.normalize(vec3.create(), this.rollDirection);
    vec3.scale(this.currentHorizontalVelocity, dir, this.initialRollSpeed);
  }

  private applyRollJump(): void {
    // Aplicar fuerza vertical aumentada
    this.currentVerticalVelocity = this.rollJumpVerticalForce;

    // Determinar dirección del impulso horizontal
    let boostDirection = vec3.create();

    // Si hay velocidad horizontal actual, usar esa dirección
    if (vec3.length(this.currentHorizontalVelocity) > 0.1) {
      vec3.normalize(boostDirection, this.currentHorizontalVelocity);
    }
    // Si no hay movimiento, usar la dirección de la cámara (forward)
    else {
      const forward = this.camera!.getCamera().getFront();
      boostDirection[0] = forward[0];
      boostDirection[1] = 0;
      boostDirection[2] = forward[2];
      vec3.normalize(boostDirection, boostDirection);
    }

    // Aplicar impulso horizontal en la dirección determinada
    vec3.scale(this.currentHorizontalVelocity, boostDirection, this.rollJumpHorizontalBoost);
    this.horizontalSpeed = vec3.length(this.currentHorizontalVelocity);
    vec3.normalize(this.horizontalDirection, this.currentHorizontalVelocity);

    this.isJumping = true; // Iniciar salto variable
    this.timeSinceGrounded = this.coyoteTime + 1.0; // Invalidar coyote time después del salto
    this.jumpCutFactorApplied = false;
    this.flowComponent?.notifyAction('roll');
  }

  //WALLRUN
  private detectWall(): void {
    this.isNearWall = false;

    const facingVector = this.camera!.getCamera().getFront();
    facingVector[1] = 0;
    vec3.normalize(facingVector, facingVector);

    const wallDistance = this.detectWallDistance;

    const left = this.camera!.getCamera().getLeft();
    left[1] = 0;
    vec3.normalize(left, left);

    const right = vec3.scale(vec3.create(), left, -1);
    const origin = this.capsuleCollider.getRigidBody().translation();

    const physics = Engine.getPhysics();
    const leftRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: left[0], y: left[1], z: left[2] },
    );
    const leftHit = physics.getWorld().castRayAndGetNormal(
      leftRay,
      wallDistance,
      true, // solid
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, // sin filtro de grupos
      this.capsuleCollider.getCollider(), // Excluir solo el propio collider
    );

    if (
      leftHit &&
      leftHit.collider &&
      leftHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(leftHit.normal.x, leftHit.normal.y, leftHit.normal.z);
      const facing = vec3.dot(facingVector, n);
      if (facing < -this.wallRunMaxEntryAngle) return;
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }

    const rightRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: right[0], y: right[1], z: right[2] },
    );
    const rightHit = physics.getWorld().castRayAndGetNormal(
      rightRay,
      wallDistance,
      true, // solid
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, // sin filtro de grupos
      this.capsuleCollider.getCollider(), // Excluir solo el propio collider
    );

    if (
      rightHit &&
      rightHit.collider &&
      rightHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(rightHit.normal.x, rightHit.normal.y, rightHit.normal.z);
      const facing = vec3.dot(facingVector, n);
      if (facing < -this.wallRunMaxEntryAngle) return;
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }

    if (this.isNearWall && !this.isGrounded && !this.isMantling && !this.isWallRunning) {
      this.startWallRun();
    } else if (this.isGrounded) {
      this.isWallRunning = false;
    }

    const backRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: -facingVector[0], y: -facingVector[1], z: -facingVector[2] },
    );
    const backHit = physics.getWorld().castRayAndGetNormal(
      backRay,
      wallDistance,
      true, // solid
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, // sin filtro de grupos
      this.capsuleCollider.getCollider(), // Excluir solo el propio collider
    );

    if (
      backHit &&
      backHit.collider &&
      backHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(backHit.normal.x, backHit.normal.y, backHit.normal.z);
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }

    if (this.isNearWall && !this.isGrounded && !this.isMantling && !this.isWallRunning) {
      this.startWallRun();
    } else if (this.isGrounded) {
      this.isWallRunning = false;
    }
  }

  private startWallRun(): void {
    const speed = vec3.length(this.currentHorizontalVelocity);
    if (speed < this.minWallRunSpeed) return;
    this.isWallRunning = true;
    this.currentWallRunTime = 0.0; // Reset timer
    if (this.currentVerticalVelocity < 0.0) {
      this.currentVerticalVelocity = 0.0;
    }
    this.removeVelocityIntoWallForWallRun(this.wallNormal);
  }

  private updateWallRun(deltaTime: number): void {
    const input = Engine.getInput();
    this.currentWallRunTime += deltaTime;

    // salir si nos alejamos de la pared
    if (!this.isNearWall || this.currentWallRunTime >= this.maxWallRunDuration) {
      this.endWallRun();
      return;
    }

    // saltar fuera de la pared
    if (input.isActionBuffered(GameAction.JUMP)) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.applyWallJump();
    }
  }

  private endWallRun(): void {
    this.isWallRunning = false;
  }

  private manageHorizontalMovementForWallRun(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;

    //Solo puedes ir hacia adelante o atras de la pared
    let wallTangent = this.projectOntoWallTangent(targetMovement, this.wallNormal);
    vec3.normalize(wallTangent, wallTangent);
    vec3.copy(targetMovement, wallTangent);

    const horizontalDirection = vec3.normalize(vec3.create(), this.currentHorizontalVelocity);
    const alignment = vec3.dot(targetMovement, horizontalDirection);

    let keysFactor = 1.0;
    if (hasInput && alignment > 0.0) {
      keysFactor = 0.5;
    } else if (hasInput && alignment <= 0.0) {
      keysFactor = 2.0;
    }

    const dragFactor = Math.pow(1.0 - this.wallDrag * keysFactor, deltaTime);
    vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, dragFactor);
  }

  private removeVelocityIntoWallForWallRun(collisionNormal: vec3): void {
    const speed = vec3.length(this.currentHorizontalVelocity);

    const dot =
      this.currentHorizontalVelocity[0] * collisionNormal[0] +
      this.currentHorizontalVelocity[1] * collisionNormal[1] +
      this.currentHorizontalVelocity[2] * collisionNormal[2];
    // si el vector apunta hacia la pared (dot < 0):
    if (dot < 0) {
      this.currentHorizontalVelocity[0] -= dot * collisionNormal[0];
      this.currentHorizontalVelocity[1] -= dot * collisionNormal[1];
      this.currentHorizontalVelocity[2] -= dot * collisionNormal[2];
    }

    const horizontalDirection = vec3.normalize(vec3.create(), this.currentHorizontalVelocity);
    this.currentHorizontalVelocity = vec3.scale(
      this.currentHorizontalVelocity,
      horizontalDirection,
      speed * this.initialDragFactorDuringWallRun,
    );
  }

  //WALLJUMP
  private applyWallJump(): void {
    this.isNearWall = false;
    this.isWallRunning = false;
    this.inputDisableTimer = this.disableInputAfterWallJumpTime;

    let jumpDir = this.camera!.getCamera().getFront();
    jumpDir[1] = 0.0;
    vec3.normalize(jumpDir, jumpDir);
    const d = vec3.dot(jumpDir, this.wallNormal);
    if (d < 0.2) {
      vec3.add(jumpDir, jumpDir, this.wallNormal);
      vec3.normalize(jumpDir, jumpDir);
    }

    const speed = vec3.length(this.currentHorizontalVelocity);
    this.currentHorizontalVelocity = vec3.scale(
      this.currentHorizontalVelocity,
      jumpDir,
      speed * 0.85,
    );
    this.applyJump(this.jumpVelocity);
  }

  //MANTLING
  private manageMantling(): void {
    const input = Engine.getInput();

    // No permitir mantle si ya estamos cayendo muy rápido o si estamos en el suelo
    if (
      this.currentVerticalVelocity < this.mantlingMinVerticalVelocity ||
      this.isWallRunning ||
      this.isGrounded ||
      this.isMantling
    ) {
      return;
    }

    if (input.isActionPressed(GameAction.MOVE_FORWARD)) {
      const mantleInfo = this.detectMantleOpportunity();
      if (mantleInfo) {
        this.startMantle(mantleInfo.targetPosition);
      }
    }
  }

  private detectMantleOpportunity(): { targetPosition: vec3 } | null {
    const physics = Engine.getPhysics();
    const cameraObj = this.camera!.getCamera();
    const playerPos = this.capsuleCollider.getRigidBody().translation();

    // Dirección horizontal hacia adelante (sin componente Y)
    let forward = cameraObj.getFront();
    forward[1] = 0;
    vec3.normalize(forward, forward);
    // Calcular distancia dinámica basada en velocidad horizontal
    const currentSpeed = vec3.length(this.currentHorizontalVelocity);
    const speedRatio = Math.min(currentSpeed / (this.maxSpeed * 2.0), 2.0); // Máximo 2x a velocidad de correr
    const dynamicDetectionDistance = this.mantleDetectionDistance * (1.0 + speedRatio * 0.8); // Hasta 1.8x la distancia base

    // 1. Raycast horizontal a altura de pecho para detectar obstáculo
    const chestHeight = playerPos.y;
    const ray1 = new RAPIER.Ray(
      { x: playerPos.x, y: chestHeight, z: playerPos.z },
      { x: forward[0], y: 0, z: forward[2] },
    );

    const wallHit = physics
      .getWorld()
      .castRay(
        ray1,
        dynamicDetectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.capsuleCollider.getCollider(),
      );

    // Si no hay pared enfrente, no hay mantle
    if (!wallHit) return null;

    // Solo permitir mantle en paredes estáticas
    if (wallHit.collider.parent()!.bodyType() !== RAPIER.RigidBodyType.Fixed) {
      return null;
    }
    // 2. Raycast vertical desde arriba de la pared hacia abajo para encontrar superficie
    const wallDistance = wallHit.timeOfImpact;
    const wallPoint = vec3.fromValues(
      playerPos.x + forward[0] * wallDistance,
      playerPos.y,
      playerPos.z + forward[2] * wallDistance,
    );

    // Buscar superficie arriba de la pared
    // Raycast desde arriba hacia abajo
    const ray2 = new RAPIER.Ray(
      {
        x: wallPoint[0] + forward[0] * 0.5,
        y: playerPos.y + this.originalHeight / 2.0 + this.originalRadius,
        z: wallPoint[2] + forward[2] * 0.5,
      },
      { x: 0, y: -1, z: 0 },
    );

    const groundHit = physics
      .getWorld()
      .castRay(
        ray2,
        this.originalHeight + this.originalRadius * 2.0,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.capsuleCollider.getCollider(),
      );

    if (groundHit) {
      const surfaceHeight = ray2.origin.y - groundHit.timeOfImpact;

      // Verificar que la superficie no esté muy alta
      if (surfaceHeight > cameraObj.getPosition()[1] + this.mantleMaxHeight) {
        return null;
      }

      // Verificar que hay espacio suficiente arriba para el jugador
      const ray3 = new RAPIER.Ray(
        {
          x: wallPoint[0] + forward[0] * 0.5,
          y: surfaceHeight + 0.1,
          z: wallPoint[2] + forward[2] * 0.5,
        },
        { x: 0, y: 1, z: 0 },
      );

      const ceilingHit = physics
        .getWorld()
        .castRay(
          ray3,
          this.originalHeight + 0.5,
          true,
          QueryFilterFlags.EXCLUDE_SENSORS,
          undefined,
          this.capsuleCollider.getCollider(),
        );

      // Si hay techo muy cerca, no podemos trepar
      if (ceilingHit && ceilingHit.timeOfImpact < this.originalHeight) {
        return null;
      }

      // ¡Encontramos un lugar válido para trepar!
      const targetPosition = vec3.fromValues(
        wallPoint[0] + forward[0] * 0.5,
        surfaceHeight + this.originalHeight / 2.0,
        wallPoint[2] + forward[2] * 0.5,
      );
      return { targetPosition };
    }

    return null;
  }

  private startMantle(targetPosition: vec3): void {
    this.isMantling = true;
    vec3.copy(this.mantleTargetPos, targetPosition);

    // Guardar velocidad ANTES de cancelar el movimiento
    this.mantleStoredVelocity = Math.max(
      vec3.length(this.currentHorizontalVelocity),
      this.minMantleVelocity,
    );
    this.currentVerticalVelocity = 0.0;
    this.isJumping = false;
  }

  private manageMantleDirection(): vec3 {
    const currentPos = this.capsuleCollider.getRigidBody().translation();
    const pos = vec3.fromValues(currentPos.x, currentPos.y, currentPos.z);

    const vector = vec3.create();
    vec3.subtract(vector, this.mantleTargetPos, pos);
    const distance = vec3.length(vector);
    if (distance < 0.3) {
      this.endMantle();
    }

    let dir = vec3.fromValues(
      this.mantleTargetPos[0] - pos[0],
      this.mantleTargetPos[1] - pos[1],
      this.mantleTargetPos[2] - pos[2],
    );
    vec3.normalize(dir, dir);
    return vec3.scale(vec3.create(), dir, this.mantleStoredVelocity);
  }

  private endMantle(): void {
    this.isMantling = false;
    this.currentHorizontalVelocity = vec3.normalize(vec3.create(), this.currentHorizontalVelocity);
    vec3.scale(
      this.currentHorizontalVelocity,
      this.currentHorizontalVelocity,
      this.mantleStoredVelocity,
    );
  }

  //DASH
  private manageDashing(): void {
    const input = Engine.getInput();

    // Solo permitir dash si no estamos en mantle, swing o con input deshabilitado
    if (this.isDashing || this.isMantling || this.isSwinging || !this.canDash) {
      return;
    }

    // Detectar click derecho (MouseButton.RIGHT = 2)
    if (input.isActionJustPressed(GameAction.DASH)) {
      const dashPoint = this.detectDashPoint();
      if (dashPoint) {
        this.startDash(dashPoint);
      }
    }
  }

  private detectDashPoint(): vec3 | null {
    const physics = Engine.getPhysics();
    const cameraObj = this.camera!.getCamera();
    const playerPos = this.capsuleCollider.getRigidBody().translation();

    // Dirección de la cámara
    const forward = cameraObj.getFront();

    // Raycast desde la posición del jugador hacia donde mira la cámara
    const ray = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: forward[0], y: forward[1], z: forward[2] },
    );

    // InteractionGroups: Ray del PLAYER que busca solo DASH_TRIGGER
    // Formato Rapier: 16 bits ALTOS = membership, 16 bits BAJOS = filter
    // membership: PLAYER (el ray pertenece al grupo PLAYER)
    // filter: DASH_TRIGGER (el ray solo detecta objetos con grupo DASH_TRIGGER)
    const interactionGroups =
      ((CollisionGroups.PLAYER & 0xffff) << 16) | (CollisionGroups.DASH_TRIGGER & 0xffff);

    const hit = physics.getWorld().castRay(
      ray,
      this.dashDetectionDistance,
      true,
      undefined,
      interactionGroups, // Solo detectar grupo DASH_TRIGGER
      this.capsuleCollider.getCollider(),
    );

    if (!hit) return null;

    // El raycast ya garantiza que el collider es un DASH_TRIGGER sensor
    // No necesitamos verificación adicional
    const rigidBody = hit.collider.parent();
    if (!rigidBody) return null;

    // Obtener el centro del rigid body (que es el centro del trigger)
    // Esto ignora el punto exacto de impacto del raycast y va directo al centro
    const centerPos = rigidBody.translation();
    const centerPoint = vec3.fromValues(centerPos.x, centerPos.y, centerPos.z);

    return centerPoint;
  }

  private startDash(targetPoint: vec3): void {
    this.isDashing = true;
    this.canDash = false; // Consumir el dash
    vec3.copy(this.dashTargetPos, targetPoint);

    // Cancelar otras velocidades
    this.currentVerticalVelocity = 0.0;
    this.isJumping = false;
    this.isWallRunning = false;
    this.isNearWall = false;
  }

  private manageDashMovement(): vec3 {
    const currentPos = this.capsuleCollider.getRigidBody().translation();
    const pos = vec3.fromValues(currentPos.x, currentPos.y, currentPos.z);

    // Calcular dirección hacia el objetivo
    const direction = vec3.sub(vec3.create(), this.dashTargetPos, pos);
    const distanceToTarget = vec3.length(direction);

    // Si estamos cerca del objetivo, detener el dash
    if (distanceToTarget < this.dashStopDistance) {
      this.endDash();
    }

    // Normalizar dirección y aplicar velocidad de dash
    vec3.normalize(direction, direction);
    return vec3.scale(vec3.create(), direction, this.dashSpeed);
  }

  private endDash(): void {
    this.isDashing = false;
  }

  //IMPULSE PAD
  public applyImpulseFromPad(impulse: vec3): void {
    const force = impulse;

    const horizontal = vec3.fromValues(force[0], 0, force[2]);
    this.applyJump(force[1]);

    this.currentHorizontalVelocity = vec3.clone(horizontal);
    this.inputDisableTimer = this.impulsePadInputDisableTime;
  }

  //SWING BAR
  public startSwing(data: SwingEntryData): void {
    if (
      this.isSwinging ||
      (this.isGrounded && this.currentVerticalVelocity <= 0.0) ||
      this.isMantling
    )
      return;

    this.isSwinging = true;
    this.isDashing = false;

    this.swingAngle = data.startAngle;
    this.swingEndAngle = data.endAngle;
    this.swingDirection = data.direction;
    this.swingRadius = data.radius;
    vec3.copy(this.swingAxis, data.barAxis);

    this.swingSpeed = Math.max(vec3.length(this.currentHorizontalVelocity), this.minSwingSpeed);
    this.swingAngularSpeed = this.swingSpeed / this.swingRadius;

    const down = vec3.fromValues(0, -1, 0);
    vec3.copy(this.swingBase, this.projectOnPlane(down, this.swingAxis));
    vec3.normalize(this.swingBase, this.swingBase);

    vec3.cross(this.swingTangent, this.swingAxis, this.swingBase);
    vec3.normalize(this.swingTangent, this.swingTangent);

    // INVERTIR el arco si venimos del lado negativo
    if (this.swingDirection < 0) {
      vec3.scale(this.swingTangent, this.swingTangent, -1);
    }

    this.currentVerticalVelocity = 0;
    this.isJumping = false;
  }

  private manageSwingMovement(dt: number): void {
    this.swingAngle += this.swingDirection * this.swingAngularSpeed * dt;

    const finished =
      (this.swingDirection > 0 && this.swingAngle >= this.swingEndAngle) ||
      (this.swingDirection < 0 && this.swingAngle <= this.swingEndAngle);

    if (finished) {
      this.endSwing();
      return;
    }

    const radial = vec3.create();
    vec3.scale(radial, this.swingBase, Math.cos(this.swingAngle));
    vec3.scaleAndAdd(radial, radial, this.swingTangent, Math.sin(this.swingAngle));
    vec3.normalize(radial, radial);

    const velocityDir = vec3.cross(vec3.create(), this.swingAxis, radial);
    vec3.normalize(velocityDir, velocityDir);

    // Aplicar sentido SOLO en el plano horizontal (no en Y)
    velocityDir[0] *= this.swingDirection;
    velocityDir[2] *= this.swingDirection;

    vec3.scale(this.currentHorizontalVelocity, velocityDir, this.swingSpeed);
    this.currentVerticalVelocity = this.currentHorizontalVelocity[1];
    this.currentHorizontalVelocity[1] = 0;
  }

  private endSwing(): void {
    this.isSwinging = false;

    // Mantener dirección de salida
    this.currentVerticalVelocity = Math.max(this.currentVerticalVelocity, 1.5);
    this.isJumping = true;
    this.timeSinceGrounded = this.coyoteTime + 1.0;
  }

  //HELPERS
  private approach(current: number, target: number, delta: number): number {
    if (current < target) {
      return Math.min(current + delta, target);
    }
    if (current > target) {
      return Math.max(current - delta, target);
    }
    return target;
  }

  private projectOntoWallTangent(v: vec3, wallNormal: vec3): vec3 {
    const dot = vec3.dot(v, wallNormal);
    const projected = vec3.scale(vec3.create(), wallNormal, dot);
    return vec3.subtract(vec3.create(), v, projected);
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  private findCamera(): void {
    // Lazy camera search: buscar en el primer update cuando los hijos ya están cargados
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
        console.warn('CharacterControllerComponent: No camera found in children.');
      }
    }
  }

  public override renderInMenu(): void {
    alert("CharacterControllerComponent doesn't support in-menu editing yet.");
  }

  public renderDebug(): void {
    // TODO: Render debug info
    // - Draw grounded raycast
    // - Show velocity vector
  }

  public dispose(): void {
    // Cleanup if needed
  }

  public setActive(active: boolean): void {
    this.isActive = active;
  }

  public getWallNormal() {
    return this.wallNormal;
  }

  public getIsWallRunning() {
    return this.isWallRunning;
  }

  public getIsMantling() {
    return this.isMantling;
  }

  public getIsRolling() {
    return this.isRolling;
  }

  public getMaxSpeed(): number {
    return this.maxSpeed;
  }

  public getRollTimer(): number {
    return this.rollTimer;
  }

  public getRollDuration(): number {
    return this.rollDuration;
  }

  public getCurrentSpeed() {
    return vec3.length(this.currentHorizontalVelocity);
  }

  public async load(data: CharacterControllerComponentDataType): Promise<void> {
    // Obtener referencia al capsule collider
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;

    if (!this.capsuleCollider) {
      console.error(
        'CharacterControllerComponent requires CapsuleColliderComponent on the same entity!',
      );
      return;
    }

    // Guardar dimensiones originales del collider
    this.originalHeight = this.capsuleCollider.getCapsuleHeight();
    this.originalRadius = this.capsuleCollider.getCapsuleRadius();

    this.jumpVelocity = (2.0 * this.jumpHeight) / this.jumpTimeToPeak;
    this.jumpGravity = (-2.0 * this.jumpHeight) / (this.jumpTimeToPeak * this.jumpTimeToPeak);
    this.fallGravity = (-2.0 * this.jumpHeight) / (this.jumpTimeToDescent * this.jumpTimeToDescent);

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }
}
