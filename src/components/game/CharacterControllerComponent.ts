import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { GameAction } from '../../types/GameAction.enum';

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

  // Jump
  private jumpForce: number = 8.0; // Velocidad inicial del salto
  private jumpCutFactor: number = 0.6; // Factor para reducir la velocidad al soltar la tecla de salto (0.0 = cortar totalmente, 1.0 = no cortar)
  private coyoteTime: number = 0.15; // Segundos de gracia después de dejar el suelo
  private timeSinceGrounded: number = 0.0; // Tiempo desde que dejó de estar grounded

  // Slide
  private slideSpeedThreshold: number = 5.0; // Velocidad mínima para activar slide
  private slideDecelerationTime: number = 1.5; // Tiempo de frenado del slide
  private slideHeightMultiplier: number = 0.5; // Reducción de altura (0.5 = mitad de altura)
  private slideMinDuration: number = 0.5; // Tiempo mínimo del slide en segundos (no se puede cancelar antes)
  private slideVelocity: number = 0.0; // Velocidad capturada al inicio del slide
  private slideDirection: vec3 = vec3.create();
  private slideTimer: number = 0.0; // Tiempo transcurrido en slide
  private originalHeight: number = 0.0; // Altura original del collider
  private originalRadius: number = 0.0; // Radio original del collider

  // WallJump
  private wallJumpCooldown: number = 0.5; // Cooldown entre patadas en segundos
  private lastWallJumpTime: number = 0.0; // Tiempo desde la última patada

  // Mantling (trepar)
  private mantleDetectionDistance: number = 1.5; // Distancia para detectar obstáculos
  private mantleMaxHeight: number = -0.025; // Altura máxima que puede trepar relativa a la camara
  private isMantling: boolean = false; // Si está actualmente trepando
  private mantleTargetPos: vec3 = vec3.create(); // Posición objetivo del mantle
  private mantleStoredVelocity: number = 0.0;
  private minMantleVelocity: number = 8.0; // Velocidad mínima al iniciar mantle

  // Diving
  private divingGravityMultiplier: number = 4.0; // Multiplicador de gravedad al caer en picado

  // Estado
  private isActive: boolean = true;
  private isGrounded: boolean = false;
  private isJumping: boolean = false; // True mientras el jugador mantiene presionada la barra espaciadora durante el salto
  private isSliding: boolean = false;
  private isDiving: boolean = false;
  private canAirJump: boolean = false; // Permitir salto en aire tras wall jump
  private currentHorizontalVelocity: vec3 = vec3.create(); // Velocidad actual interpolada
  private currentVerticalVelocity: number = 0.0; // Velocidad vertical actual
  private jumpCutFactorApplied: boolean = false; // Si el factor de corte de salto ya se ha aplicado
  private groundNormal: vec3 = vec3.fromValues(0, 1, 0); // Normal del suelo actual

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
    if (data.slideDecelerationTime !== undefined) {
      this.slideDecelerationTime = data.slideDecelerationTime;
    }
    if (data.slideHeightMultiplier !== undefined) {
      this.slideHeightMultiplier = data.slideHeightMultiplier;
    }
    if (data.slideMinDuration !== undefined) {
      this.slideMinDuration = data.slideMinDuration;
    }
    if (data.wallJumpCooldown !== undefined) {
      this.wallJumpCooldown = data.wallJumpCooldown;
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

    this.getIsGroundedAndGroundNormal();
    this.manageMantling();
    this.manageSliding(deltaTime);
    console.log('---------------');
    console.log('isGrounded:', this.isGrounded);
    console.log('isMantling:', this.isMantling);
    console.log('isSliding:', this.isSliding);
    if (this.isMantling) {
      this.updateMantle(deltaTime);
    } else if (this.isSliding) {
      const finalVelocity = this.updateSlide(deltaTime);
      this.applyMovement(finalVelocity, deltaTime);
    } else {
      const inputDir = this.getInputVector();
      const targetMovement = this.getTargetMovement(inputDir);
      this.manageHorizontalMovement(deltaTime, targetMovement);
      this.manageVerticalMovement(deltaTime);
      const finalVelocity = this.mergeMovements();
      this.applyMovement(finalVelocity, deltaTime);
    }

    /*
    this.manageWallJump(deltaTime);
    */

    // Select velocity to apply
    //const velocityToApply = this.isSliding ? this.slideVelocity : this.currentVelocity;
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

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
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

  private applyGravity(deltaTime: number): void {
    // Actualizar velocidad vertical con gravedad
    if (!this.isGrounded) {
      const multiplier = this.isDiving ? this.divingGravityMultiplier : 1.0;
      this.currentVerticalVelocity += gravity * deltaTime * multiplier;
    } else if (this.isGrounded && !this.isJumping) {
      this.currentVerticalVelocity = 0.0;
    }
  }

  private manageSliding(deltaTime: number): void {
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

  private manageDiving(): void {
    const input = Engine.getInput();

    if (input.isActionJustPressed(GameAction.DIVE) && !this.isGrounded) {
      this.isDiving = true;
    }
  }

  private manageWallJump(deltaTime: number): void {
    const input = Engine.getInput();

    // Actualizar cooldown de walljump
    if (this.lastWallJumpTime > 0.0) {
      this.lastWallJumpTime -= deltaTime;
      if (this.lastWallJumpTime < 0.0) {
        this.lastWallJumpTime = 0.0;
      }
      return;
    }

    if (input.isActionBuffered(GameAction.WALL_JUMP)) {
      input.consumeBufferedAction(GameAction.WALL_JUMP);
      const physics = Engine.getPhysics();

      const cameraObj = this.camera!.getCamera();
      let cameraForward = cameraObj.getFront();
      vec3.normalize(cameraForward, cameraForward);
      const cameraPos = cameraObj.getPosition();

      // Raycast desde el centro de la cápsula hacia adelante
      const ray = new RAPIER.Ray(
        { x: cameraPos[0], y: cameraPos[1], z: cameraPos[2] },
        { x: cameraForward[0], y: cameraForward[1], z: cameraForward[2] },
      );

      // Excluir el propio collider del raycast
      const hit = physics.getWorld().castRay(
        ray,
        2.0,
        true, // solid
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined, // sin filtro de grupos
        this.capsuleCollider.getCollider(), // Excluir solo el propio collider
      );

      if (hit && hit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed) {
        this.applyWallJump();
        this.canAirJump = true;
        this.isDiving = false;
        console.log('enable air jump');
        this.lastWallJumpTime = this.wallJumpCooldown; // Iniciar cooldown
      } else if (hit && hit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Dynamic) {
        if (!this.isGrounded) {
          this.applyWallJump(0.5);
          this.isDiving = false;
        } else {
          this.currentVelocity = vec3.fromValues(0, 0, 0);
        }
        this.kickObject(hit.collider.parent()!);
        this.lastWallJumpTime = this.wallJumpCooldown; // Iniciar cooldown
      }
    }
  }

  private manageMantling(): void {
    const input = Engine.getInput();

    // No permitir mantle si ya estamos cayendo muy rápido o si estamos en el suelo
    if (this.currentVerticalVelocity < -5.0 || this.isGrounded || this.isDiving) {
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

  private applyWallJump(factor: number = 1.0): void {
    const cameraObj = this.camera!.getCamera();
    let cameraForward = cameraObj.getFront();
    cameraForward[1] = 0.0;
    vec3.normalize(cameraForward, cameraForward);

    let wallJumpVelocity = vec3.create();
    vec3.scale(wallJumpVelocity, cameraForward, -4.0 * factor);
    let wallJumpVerticalVelocity = vec3.fromValues(0, 5.0 * factor, 0);

    vec3.add(wallJumpVelocity, wallJumpVelocity, wallJumpVerticalVelocity);

    this.currentVelocity = wallJumpVelocity;
  }

  private kickObject(rigidbody: RAPIER.RigidBody): void {
    const cameraObj = this.camera!.getCamera();
    let cameraForward = cameraObj.getFront();
    cameraForward[1] = 0.0;
    vec3.normalize(cameraForward, cameraForward);

    let kickObjectVelocity = vec3.create();
    vec3.scale(kickObjectVelocity, cameraForward, 8.0);
    let kickObjectJumpVelocity = vec3.fromValues(0, 5.0, 0);

    vec3.add(kickObjectVelocity, kickObjectVelocity, kickObjectJumpVelocity);

    rigidbody.applyImpulse(
      new RAPIER.Vector3(kickObjectVelocity[0], kickObjectVelocity[1], kickObjectVelocity[2]),
      true,
    );
  }

  private manageHorizontalMovement(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;

    if (this.isGrounded) {
      // EN SUELO: Control normal con aceleración suave
      if (hasInput) {
        vec3.scale(this.currentHorizontalVelocity, targetMovement, this.moveSpeed);
      } else {
        // Deceleración en suelo
        vec3.set(this.currentHorizontalVelocity, 0, 0, 0);
      }
    } else {
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
    }
  }

  private manageVerticalMovement(deltaTime: number): void {
    this.manageDiving();
    this.applyGravity(deltaTime);
    this.manageJump(deltaTime);
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
      const isFloor = collision.normal1.y > 0.1;

      // Si es suelo → ignorar completamente para lógica de pared
      if (isFloor) {
        continue;
      }

      if (type === RAPIER.RigidBodyType.Fixed) {
        this.removeVelocityIntoWall(collision.normal1);
        this.slowDownOnWallCollision();
      }
    }
  }

  private removeVelocityIntoWall(collisionNormal: RAPIER.Vector3): void {
    const dot =
      this.currentHorizontalVelocity[0] * collisionNormal.x +
      this.currentHorizontalVelocity[1] * collisionNormal.y +
      this.currentHorizontalVelocity[2] * collisionNormal.z;

    // si el vector apunta hacia la pared (dot < 0):
    if (dot < 0) {
      this.currentHorizontalVelocity[0] -= dot * collisionNormal.x;
      this.currentHorizontalVelocity[1] -= dot * collisionNormal.y;
      this.currentHorizontalVelocity[2] -= dot * collisionNormal.z;
    }
  }

  private slowDownOnWallCollision(): void {
    this.currentHorizontalVelocity[0] *= 0.9;
    this.currentHorizontalVelocity[2] *= 0.9;
  }

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
      if (canGroundJump || this.canAirJump) {
        this.applyJump();
        this.isJumping = true; // Iniciar salto variable
        this.canAirJump = false; // Consumir posible air jump
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
    }
  }

  private applyJump(): void {
    this.currentVerticalVelocity = this.jumpForce;
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

    // Reducir altura del collider
    const newHeight = this.originalHeight * this.slideHeightMultiplier;
    this.applyCapsuleHeight(newHeight);
  }

  private updateSlide(deltaTime: number): vec3 {
    const input = Engine.getInput();
    this.slideTimer += deltaTime;

    // Decelerar progresivamente el slide
    const t = Math.min(1.0, this.slideTimer / this.slideDecelerationTime);
    const decelCurve = 1.0 - Math.pow(t, 3.0); // Curva cuadrática de frenado

    // Aplicar deceleración manteniendo dirección
    this.slideVelocity *= decelCurve;

    const horizontal = this.slideDirection;
    const projected = this.projectOnPlane(horizontal, this.groundNormal);

    // Normalize final movement
    vec3.normalize(projected, projected);

    const result = vec3.scale(vec3.create(), projected, this.slideVelocity);

    // Terminar slide solo si:
    // 1. Ha pasado el tiempo mínimo Y (soltamos tecla O se acabó tiempo O velocidad baja)
    // 2. O perdemos contacto con el suelo (cancelación forzada)
    const minDurationPassed = this.slideTimer >= this.slideMinDuration;
    const shouldEndSlide = !input.isActionPressed(GameAction.SLIDE) || this.slideVelocity < 2.0;
    if (!this.isGrounded || (minDurationPassed && shouldEndSlide)) {
      this.endSlide(result);
    }

    return result;
  }

  private endSlide(currentVelocity: vec3): void {
    if (!this.isSliding) return;
    this.isSliding = false;
    this.slideTimer = 0.0;

    // Restaurar altura original del collider
    this.applyCapsuleHeight(this.originalHeight);

    // Transferir velocidad del slide al movimiento normal
    vec3.copy(this.currentHorizontalVelocity, currentVelocity);
  }

  private applyCapsuleHeight(newHeight: number): void {
    if (!this.capsuleCollider) return;

    const rigidBody = this.capsuleCollider.getRigidBody();
    if (!rigidBody) return;

    const world = Engine.getPhysics().getWorld();
    var currentRadius = this.originalRadius;

    // Calcular halfHeight (altura del cilindro central, excluyendo semiesferas)
    var halfHeight = (newHeight - 2 * currentRadius) / 2;
    if (halfHeight < 0) {
      halfHeight = 0.01;
      currentRadius = (newHeight - halfHeight) / 2;
    }

    // 1. Eliminar el collider anterior
    const oldCollider = this.capsuleCollider.getCollider();
    if (oldCollider) {
      world.removeCollider(oldCollider, false);
    }

    // 2. Crear nuevo collider con la nueva altura

    const newCollider = Engine.getPhysics().addCapsuleCollider(
      this.getOwner().id,
      rigidBody,
      halfHeight,
      currentRadius,
      false,
    );

    // 3. Actualizar la referencia del collider en el componente
    (this.capsuleCollider as CapsuleColliderComponent).setCollider(newCollider);
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
