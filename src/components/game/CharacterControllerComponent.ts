import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { GameAction } from '../../types/GameAction.enum';
import { SwingEntryData } from '../../types/SwingEntryData.type';

const gravity = -9.81; // m/s²
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

  // Movement
  private moveSpeed: number = 5.0; // Unidades por segundo
  private airControlMultiplier: number = 0.3; // Control en el aire (0.0 = sin control, 1.0 = control total)
  private groundAcceleration: number = 20.0; // Aceleración en el suelo
  private groundDeceleration: number = 30.0; // Deceleración en el suelo

  // Jump
  private jumpForce: number = 8.0; // Velocidad inicial del salto
  private jumpCutFactor: number = 0.6; // Factor para reducir la velocidad al soltar la tecla de salto (0.0 = cortar totalmente, 1.0 = no cortar)
  private coyoteTime: number = 0.15; // Segundos de gracia después de dejar el suelo
  private timeSinceGrounded: number = 0.0; // Tiempo desde que dejó de estar grounded

  // Slide
  private slideSpeedThreshold: number = 5.0; // Velocidad mínima para activar slide
  private slideDownhillAccel: number = 4.0; // Tiempo de frenado del slide
  private slideFriction: number = 4.0; // Fricción base del slide
  private slideUphillBrake: number = 5.0; // Fricción adicional al subir
  private slideMinDuration: number = 0.5; // Tiempo mínimo del slide en segundos (no se puede cancelar antes)
  private slideVelocity: number = 0.0; // Velocidad capturada al inicio del slide
  private slideDirection: vec3 = vec3.create();
  private slideTimer: number = 0.0; // Tiempo transcurrido en slide
  private originalHeight: number = 0.0; // Altura original del collider
  private originalRadius: number = 0.0; // Radio original del collider

  // WallRun
  private wallNormal: vec3 = vec3.create();
  private wallRunGravity: number = -5.0; // caída lenta
  private wallRunAcceleration: number = 3.0;
  private wallRunBrake: number = 3.0;

  // WallJump
  private wallJumpForce: number = 6.0; // Fuerza aplicada al saltar desde la pared
  private disableInputAfterWallJumpTime: number = 0.2; // Tiempo que se deshabilita el input tras un wall jump

  // Mantling (trepar)
  private mantleDetectionDistance: number = 1.5; // Distancia para detectar obstáculos
  private mantleMaxHeight: number = -0.025; // Altura máxima que puede trepar relativa a la camara
  private isMantling: boolean = false; // Si está actualmente trepando
  private mantleTargetPos: vec3 = vec3.create(); // Posición objetivo del mantle
  private mantleStoredVelocity: number = 0.0;
  private minMantleVelocity: number = 8.0; // Velocidad mínima al iniciar mantle

  // Diving
  private divingGravityMultiplier: number = 4.0; // Multiplicador de gravedad al caer en picado

  // SWING STATE
  private swingAttachPoint: vec3 = vec3.create();
  private swingAxis: vec3 = vec3.create();
  private swingBase: vec3 = vec3.create(); // dirección "abajo" del arco
  private swingTangent: vec3 = vec3.create(); // eje tangencial
  private swingMaxAngle: number = 0;
  private swingRadius: number = 0;
  private swingAngle: number = 0;
  private swingSpeed: number = 0;
  private minSwingSpeed: number = 4.0;
  private swingAngularSpeed: number = 0;
  private swingEndAngle: number = 0;
  private swingDirection: number = 1;

  // Estado
  private isActive: boolean = true;
  private isGrounded: boolean = false;
  private isJumping: boolean = false;
  private isSliding: boolean = false;
  private isDiving: boolean = false;
  private isSwinging: boolean = false;
  private isWallRunning: boolean = false;
  private isNearWall: boolean = false;
  private horizontalSpeed: number = 0.0; // Velocidad horizontal actual
  private horizontalDirection: vec3 = vec3.fromValues(0, 0, 1);
  private currentHorizontalVelocity: vec3 = vec3.create(); // Velocidad actual interpolada
  private currentVerticalVelocity: number = 0.0; // Velocidad vertical actual
  private jumpCutFactorApplied: boolean = false; // Si el factor de corte de salto ya se ha aplicado
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0); // Normal del suelo actual
  private inputDisableTimer: number = -10.0; // Temporizador para deshabilitar input

  constructor() {
    super();
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

    // Load parameters from data
    if (data.moveSpeed !== undefined) {
      this.moveSpeed = data.moveSpeed;
    }
    if (data.jumpForce !== undefined) {
      this.jumpForce = data.jumpForce;
    }
    if (data.coyoteTime !== undefined) {
      this.coyoteTime = data.coyoteTime;
    }
    if (data.airControlMultiplier !== undefined) {
      this.airControlMultiplier = data.airControlMultiplier;
    }
    if (data.slideSpeedThreshold !== undefined) {
      this.slideSpeedThreshold = data.slideSpeedThreshold;
    }
    if (data.slideMinDuration !== undefined) {
      this.slideMinDuration = data.slideMinDuration;
    }

    // Guardar dimensiones originales del collider
    this.originalHeight = this.capsuleCollider.getCapsuleHeight();
    this.originalRadius = this.capsuleCollider.getCapsuleRadius();

    // NO buscar cámara aquí - las entidades hijas aún no están cargadas
    // La buscaremos en el primer update()

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public update(deltaTime: number): void {
    if (!this.isActive) return;
    this.findCamera();

    if (!this.capsuleCollider || !this.camera) return;

    if (this.inputDisableTimer > 0.0) {
      this.inputDisableTimer -= deltaTime;
    }

    this.getIsGroundedAndGroundNormal();
    this.manageMantling();
    this.detectWall();
    this.manageSliding();

    if (this.isMantling) {
      this.updateMantle(deltaTime);
    } else if (this.isSliding) {
      const finalVelocity = this.updateSlide(deltaTime);
      this.applyMovement(finalVelocity, deltaTime);
    } else if (this.isWallRunning) {
      this.updateWallRun();
      const inputDir = this.getInputVector();
      const targetMovement = this.getTargetMovement(inputDir);
      this.manageHorizontalMovementForWallRun(deltaTime, targetMovement);
      this.manageVerticalMovement(deltaTime);
      const finalVelocity = this.mergeMovements();
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
  private getIsGroundedAndGroundNormal(): void {
    const hit = this.capsuleCollider.raycastGrounded(0.1);
    this.isGrounded = hit !== null;
    if (this.isGrounded) {
      this.isDiving = false;
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

    if (this.inputDisableTimer > 0.0) return inputDir;

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
      if (hasInput) {
        vec3.normalize(this.horizontalDirection, targetMovement);
      } else {
        vec3.normalize(this.horizontalDirection, this.currentHorizontalVelocity);
        this.horizontalDirection = this.projectOnPlane(this.horizontalDirection, this.groundNormal);
      }
      const targetSpeed = hasInput ? this.moveSpeed : 0.0;
      const accel = hasInput ? this.groundAcceleration : this.groundDeceleration;
      this.horizontalSpeed = this.approach(this.horizontalSpeed, targetSpeed, accel * deltaTime);

      vec3.scale(this.currentHorizontalVelocity, this.horizontalDirection, this.horizontalSpeed);
    } else {
      vec3.normalize(this.horizontalDirection, this.currentHorizontalVelocity);
      // EN AIRE: Preservar momentum + pequeñas correcciones
      if (hasInput) {
        vec3.scale(targetMovement, targetMovement, this.moveSpeed);
        // Calcular velocidad de corrección basada en el input
        const correctionVelocity = vec3.scale(
          vec3.create(),
          targetMovement,
          this.airControlMultiplier,
        );
        // Añadir la corrección a la velocidad actual (acumulativa)
        vec3.add(
          this.currentHorizontalVelocity,
          this.currentHorizontalVelocity,
          vec3.scale(vec3.create(), correctionVelocity, deltaTime),
        );

        // Limitar la velocidad máxima para evitar aceleración infinita
        const currentSpeed = vec3.length(this.currentHorizontalVelocity);
        const maxAirSpeed = this.moveSpeed * 1.0;
        if (currentSpeed > maxAirSpeed) {
          vec3.normalize(this.currentHorizontalVelocity, this.currentHorizontalVelocity);
          vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, maxAirSpeed);
        }
      } else {
        // Sin input en el aire: mantener momentum (casi sin deceleración)
        // Solo una deceleración mínima por resistencia del aire
        const airDrag = 0.1; // 10% de drag por segundo
        const dragFactor = Math.pow(1.0 - airDrag, deltaTime);
        vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, dragFactor);
      }

      this.horizontalSpeed = vec3.length(this.currentHorizontalVelocity);
    }
  }

  private manageVerticalMovement(deltaTime: number): void {
    this.manageDiving();
    this.applyGravity(deltaTime);
    this.manageJump(deltaTime);
  }

  private applyGravity(deltaTime: number): void {
    // Actualizar velocidad vertical con gravedad
    if (!this.isGrounded) {
      const multiplier = this.isDiving ? this.divingGravityMultiplier : 1.0;
      const finalGravity = this.isWallRunning ? this.wallRunGravity : gravity;
      this.currentVerticalVelocity += finalGravity * deltaTime * multiplier;
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
        if (this.isGrounded) {
          this.removeVelocityIntoWall(collisionNormal);
        } else {
          const isCeiling = collisionNormal[1] < -0.7;
          if (isCeiling && this.currentVerticalVelocity > 0) {
            this.currentVerticalVelocity = 0;
            this.isJumping = false;
          }
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
    if (input.isActionBuffered(GameAction.JUMP)) {
      input.consumeBufferedAction(GameAction.JUMP);
      if (canGroundJump) {
        this.applyJump();
        this.isJumping = true; // Iniciar salto variable
        this.timeSinceGrounded = this.coyoteTime + 1.0; // Invalidar coyote time después del salto
        this.jumpCutFactorApplied = false;
      }
    } else if (
      this.isJumping &&
      this.currentVerticalVelocity > 0 &&
      this.currentVerticalVelocity < 1.0 &&
      !this.jumpCutFactorApplied
    ) {
      this.currentVerticalVelocity *= this.jumpCutFactor; // Reducir velocidad vertical al llegar al apex
      this.jumpCutFactorApplied = true;
      this.isJumping = false;
    } else if (this.isJumping && this.currentVerticalVelocity <= 0) {
      this.jumpCutFactorApplied = true;
      this.isJumping = false;
    }
  }

  private applyJump(): void {
    this.currentVerticalVelocity = this.jumpForce;
  }

  //WALLRUN
  private detectWall(): void {
    this.isNearWall = false;

    if (this.inputDisableTimer > 0.0) {
      return;
    }

    const facingVector = this.camera!.getCamera().getFront();
    facingVector[1] = 0;
    vec3.normalize(facingVector, facingVector);

    const wallDistance = 0.6;

    const left = this.camera!.getCamera().getLeft();
    left[1] = 0;
    vec3.normalize(left, left);

    const right = vec3.scale(vec3.create(), left, -1);
    const origin = vec3.clone(this.camera!.getCamera().getPosition());

    const physics = Engine.getPhysics();
    const leftRay = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
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
      if (facing < -0.9) return;
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }

    const rightRay = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
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
      if (facing < -0.9) return;
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
    this.isWallRunning = true;
    this.horizontalDirection[1] = 0.0;
    this.removeVelocityIntoWall(this.wallNormal);
  }

  private updateWallRun(): void {
    const input = Engine.getInput();

    // salir si nos alejamos de la pared
    if (!this.isNearWall) {
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
    if (vec3.length(wallTangent) < 0.001) {
      // input completamente perpendicular → ignorar
      return;
    }
    vec3.normalize(wallTangent, wallTangent);
    vec3.copy(targetMovement, wallTangent);

    if (hasInput) {
      if (this.horizontalSpeed < 0.1) {
        vec3.copy(this.horizontalDirection, targetMovement);
      }
      const alignment = vec3.dot(targetMovement, this.horizontalDirection);

      if (alignment > 0.0) {
        // 👉 MISMA DIRECCIÓN → ACELERAR
        this.horizontalSpeed = this.approach(
          this.horizontalSpeed,
          this.moveSpeed,
          this.wallRunAcceleration * deltaTime,
        );
      } else {
        // 👉 DIRECCIÓN CONTRARIA → FRENAR
        this.horizontalSpeed = this.approach(
          this.horizontalSpeed,
          0.0,
          this.wallRunBrake * deltaTime,
        );
      }

      vec3.scale(this.currentHorizontalVelocity, this.horizontalDirection, this.horizontalSpeed);
    } else {
      vec3.normalize(this.horizontalDirection, this.currentHorizontalVelocity);
      const airDrag = 0.3; // 30% de drag por segundo
      const dragFactor = Math.pow(1.0 - airDrag, deltaTime);
      vec3.scale(this.currentHorizontalVelocity, this.currentHorizontalVelocity, dragFactor);
      this.horizontalSpeed = vec3.length(this.currentHorizontalVelocity);
    }
  }

  //WALLJUMP
  private applyWallJump(): void {
    let jumpDir = this.camera!.getCamera().getLeft();
    const d = vec3.dot(jumpDir, this.wallNormal);
    if (d < -0.1) {
      // Pared a la izquierda, saltar a la derecha
      jumpDir = vec3.scale(vec3.create(), jumpDir, -1);
    }
    jumpDir[1] = 0.0;
    vec3.normalize(jumpDir, jumpDir);

    this.isNearWall = false;
    this.isWallRunning = false;
    this.inputDisableTimer = this.disableInputAfterWallJumpTime;

    vec3.scale(jumpDir, jumpDir, this.moveSpeed);
    this.currentVerticalVelocity = this.wallJumpForce;
    vec3.add(this.currentHorizontalVelocity, jumpDir, this.currentHorizontalVelocity);
    vec3.normalize(this.horizontalDirection, this.currentHorizontalVelocity);
    vec3.scale(this.currentHorizontalVelocity, this.horizontalDirection, this.moveSpeed);
  }

  //DIVING
  private manageDiving(): void {
    const input = Engine.getInput();

    if (input.isActionJustPressed(GameAction.DIVE) && !this.isGrounded && !this.isWallRunning) {
      this.isDiving = true;
    }
  }

  //SLIDING
  private manageSliding(): void {
    const input = Engine.getInput();
    if (!this.isSliding && input.isActionJustPressed(GameAction.SLIDE)) {
      // Activar slide solo si estamos en el suelo, con velocidad suficiente Y moviendo hacia adelante (W)
      const isMovingForward = input.isActionPressed(GameAction.MOVE_FORWARD);
      const isMovingBackward = input.isActionPressed(GameAction.MOVE_BACKWARD);
      const currentSpeed = vec3.length(this.currentHorizontalVelocity);
      if (
        this.isGrounded &&
        currentSpeed >= this.slideSpeedThreshold &&
        isMovingForward &&
        !isMovingBackward
      ) {
        this.startSlide();
      }
    }
  }

  private startSlide(): void {
    this.isSliding = true;
    this.slideTimer = 0.0;
    // Capturar velocidad actual para el slide
    this.slideVelocity = vec3.length(this.currentHorizontalVelocity);
    const horizontal = vec3.fromValues(
      this.currentHorizontalVelocity[0],
      0,
      this.currentHorizontalVelocity[2],
    );
    vec3.copy(this.slideDirection, vec3.normalize(vec3.create(), horizontal));
  }

  private updateSlide(deltaTime: number): vec3 {
    const input = Engine.getInput();
    this.slideTimer += deltaTime;

    const horizontal = this.slideDirection;
    const projected = this.projectOnPlane(horizontal, this.groundNormal);

    // Normalize final movement
    vec3.normalize(projected, projected);

    const gravityDir = vec3.fromValues(0, -1, 0);
    const downhill = this.projectOnPlane(gravityDir, this.groundNormal);
    let downhillFactor = 0.0;
    if (vec3.length(downhill) > 0.001) {
      vec3.normalize(downhill, downhill);
      // Cuánto apunta el slide hacia abajo
      downhillFactor = vec3.dot(projected, downhill);
    }
    if (downhillFactor > 0) {
      // BAJADA → acelerar
      this.slideVelocity += this.slideDownhillAccel * deltaTime;
    } else {
      // SUBIDA → frenar más
      // Decelerar progresivamente el slide
      let friction = this.slideFriction;

      if (downhillFactor < 0) {
        friction += this.slideUphillBrake;
      }

      // Aplicar deceleración manteniendo dirección
      this.slideVelocity -= friction * deltaTime;
    }

    const result = vec3.scale(vec3.create(), projected, this.slideVelocity);

    // Terminar slide solo si:
    // 1. Ha pasado el tiempo mínimo Y (soltamos tecla O se acabó tiempo O velocidad baja)
    // 2. O perdemos contacto con el suelo (cancelación forzada)
    const minDurationPassed =
      this.slideTimer >= this.slideMinDuration && !input.isActionPressed(GameAction.SLIDE);
    const shouldEndSlideBecauseVelocity = this.slideVelocity < 2.0;
    if (!this.isGrounded || minDurationPassed || shouldEndSlideBecauseVelocity) {
      this.endSlide(result);
    }

    return result;
  }

  private endSlide(currentVelocity: vec3): void {
    if (!this.isSliding) return;
    this.isSliding = false;
    this.slideTimer = 0.0;

    // Transferir velocidad del slide al movimiento normal
    vec3.copy(this.currentHorizontalVelocity, currentVelocity);
  }

  //MANTLING
  private manageMantling(): void {
    const input = Engine.getInput();

    // No permitir mantle si ya estamos cayendo muy rápido o si estamos en el suelo
    if (
      this.currentVerticalVelocity < -5.0 ||
      this.isGrounded ||
      this.isDiving ||
      this.isWallRunning
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
        this.mantleDetectionDistance,
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

  private updateMantle(deltaTime: number): void {
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
    const dirScaled = vec3.scale(vec3.create(), dir, this.mantleStoredVelocity);
    this.applyMovement(dirScaled, deltaTime);
  }

  private endMantle(): void {
    this.isMantling = false;
  }

  //IMPULSE PAD
  public applyImpulseFromPad(impulse: vec3): void {
    const force = impulse;
    const up = vec3.fromValues(0, 1, 0);

    // Proyección vertical
    const verticalMag = vec3.dot(force, up);
    const vertical = vec3.create();
    vec3.scale(vertical, up, verticalMag);
    this.currentVerticalVelocity = verticalMag;

    // Componente horizontal
    const horizontal = vec3.create();
    vec3.subtract(horizontal, force, vertical);
    this.horizontalSpeed = vec3.length(horizontal);
    this.horizontalDirection = vec3.normalize(vec3.create(), horizontal);
    this.currentHorizontalVelocity = vec3.scale(
      this.currentHorizontalVelocity,
      this.horizontalDirection,
      this.horizontalSpeed,
    );

    this.isDiving = false; // Cancelar diving si lo teníamos activo
    this.isJumping = true; // Marcar como saltando
    this.inputDisableTimer = 0.5; // Deshabilitar input por un breve momento
  }

  //SWING BAR
  public startSwing(data: SwingEntryData): void {
    if (this.isSwinging || this.isGrounded || this.isMantling) return;

    this.isSwinging = true;

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

    vec3.scale(this.currentHorizontalVelocity, velocityDir, this.swingSpeed);
    this.currentVerticalVelocity = this.currentHorizontalVelocity[1];
    this.currentHorizontalVelocity[1] = 0;
  }

  private endSwing(): void {
    this.isSwinging = false;

    // Mantener dirección de salida
    this.currentVerticalVelocity = Math.max(this.currentVerticalVelocity, 1.5);
    this.isJumping = true;
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

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  private projectOntoWallTangent(v: vec3, wallNormal: vec3): vec3 {
    const dot = vec3.dot(v, wallNormal);
    const projected = vec3.scale(vec3.create(), wallNormal, dot);
    return vec3.subtract(vec3.create(), v, projected);
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

  public getCurrentSpeed(): number {
    // Retornar la magnitud de la velocidad horizontal (ignorar Y)
    const horizontalVelocity = vec3.fromValues(
      this.currentHorizontalVelocity[0],
      0.0,
      this.currentHorizontalVelocity[2],
    );
    return vec3.length(horizontalVelocity);
  }

  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  public getIsGrounded(): boolean {
    return this.isGrounded;
  }

  public getIsSliding(): boolean {
    return this.isSliding;
  }

  public getIsMantling(): boolean {
    return this.isMantling;
  }

  public getIsWallRunning(): boolean {
    return this.isWallRunning;
  }

  public getWallNormal(): vec3 {
    return this.wallNormal;
  }

  public getCurrentHorizontalVelocity(): vec3 {
    return this.currentHorizontalVelocity;
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
}
