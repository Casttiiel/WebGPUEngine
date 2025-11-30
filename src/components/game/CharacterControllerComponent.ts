import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER from '@dimforge/rapier3d';

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
  private accelerationFactor: number = 1.0; // Tiempo para alcanzar velocidad máxima (segundos)
  private decelerationFactor: number = 0.15; // Tiempo para frenar completamente (segundos)
  private airControlMultiplier: number = 0.3; // Control en el aire (0.0 = sin control, 1.0 = control total)

  // Jump
  private jumpForce: number = 8.0; // Velocidad inicial del salto
  private jumpHoldForce: number = 0.25; // Fuerza adicional mientras se mantiene el botón (m/s²)
  private jumpHoldThreshold: number = 0.15; // Tiempo máximo para aplicar jump hold (segundos)
  private jumpHoldTimer: number = 0.0; // Timer para jump hold
  private jumpCutFactor: number = 0.6; // Factor para reducir la velocidad al soltar la tecla de salto (0.0 = cortar totalmente, 1.0 = no cortar)

  // Coyote time - permite saltar justo después de dejar el suelo
  private coyoteTime: number = 0.15; // Segundos de gracia después de dejar el suelo
  private timeSinceGrounded: number = 0.0; // Tiempo desde que dejó de estar grounded

  // Slide
  private slideSpeedThreshold: number = 5.0; // Velocidad mínima para activar slide
  private slideDecelerationTime: number = 1.5; // Tiempo de frenado del slide
  private slideHeightMultiplier: number = 0.5; // Reducción de altura (0.5 = mitad de altura)
  private slideMinDuration: number = 0.5; // Tiempo mínimo del slide en segundos (no se puede cancelar antes)
  private slideVelocity: vec3 = vec3.create(); // Velocidad capturada al inicio del slide
  private slideTimer: number = 0.0; // Tiempo transcurrido en slide
  private originalHeight: number = 0.0; // Altura original del collider
  private originalRadius: number = 0.0; // Radio original del collider

  // Estado
  private isGrounded: boolean = false;
  private isJumping: boolean = false; // True mientras el jugador mantiene presionada la barra espaciadora durante el salto
  private isSliding: boolean = false;
  private currentVelocity: vec3 = vec3.create(); // Velocidad actual interpolada
  private jumpCutFactorApplied: boolean = false; // Si el factor de corte de salto ya se ha aplicado

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
    if (data.jumpHoldForce !== undefined) {
      this.jumpHoldForce = data.jumpHoldForce;
    }
    if (data.accelerationFactor !== undefined) {
      this.accelerationFactor = data.accelerationFactor;
    }
    if (data.accelerationFactor !== undefined) {
      this.accelerationFactor = data.accelerationFactor;
    }
    if (data.decelerationFactor !== undefined) {
      this.decelerationFactor = data.decelerationFactor;
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

    // Guardar dimensiones originales del collider
    this.originalHeight = this.capsuleCollider.getCapsuleHeight();
    this.originalRadius = this.capsuleCollider.getCapsuleRadius();

    // NO buscar cámara aquí - las entidades hijas aún no están cargadas
    // La buscaremos en el primer update()

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public update(deltaTime: number): void {
    this.findCamera();

    if (!this.capsuleCollider || !this.camera) return;

    const inputDir = this.getInputVector();
    const targetMovement = this.getTargetMovement(inputDir);

    this.manageSliding(deltaTime);
    this.manageMovement(deltaTime, targetMovement);
    this.applyGravity(deltaTime);
    this.manageJump(deltaTime);

    // Select velocity to apply
    const velocityToApply = this.isSliding ? this.slideVelocity : this.currentVelocity;

    this.applyMovement(velocityToApply, deltaTime);
  }

  private getInputVector(): vec3 {
    const input = Engine.getInput();
    const inputDir = vec3.create();

    if (input.isKeyPressed(KeyCode.W)) {
      inputDir[2] -= 1; // Forward
    }
    if (input.isKeyPressed(KeyCode.S)) {
      inputDir[2] += 1; // Backward
    }
    if (input.isKeyPressed(KeyCode.A)) {
      inputDir[0] -= 1; // Left
    }
    if (input.isKeyPressed(KeyCode.D)) {
      inputDir[0] += 1; // Right
    }

    // Normalize input direction
    if (vec3.length(inputDir) > 0.01) {
      vec3.normalize(inputDir, inputDir);
    }

    return inputDir;
  }

  private getTargetMovement(inputDir: vec3): vec3 {
    const targetMovement = vec3.create();

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

    // Normalize final movement
    if (vec3.length(targetMovement) > 0.01) {
      vec3.normalize(targetMovement, targetMovement);
    }

    return targetMovement;
  }

  private applyGravity(deltaTime: number): void {
    // Actualizar velocidad vertical con gravedad
    if (this.isGrounded && this.currentVelocity[1] <= 0) {
      this.currentVelocity[1] = 0;
      this.isJumping = false;
    } else {
      this.currentVelocity[1] += gravity * deltaTime;
    }
  }

  private manageSliding(deltaTime: number): void {
    const input = Engine.getInput();
    if (!this.isSliding && input.isKeyJustPressed(KeyCode.SHIFT)) {
      // Activar slide solo si estamos en el suelo, con velocidad suficiente Y moviendo hacia adelante (W)
      const isMovingForward = input.isKeyPressed(KeyCode.W);
      const isMovingLeft = input.isKeyPressed(KeyCode.A);
      const isMovingRight = input.isKeyPressed(KeyCode.D);
      const isMovingBackward = input.isKeyPressed(KeyCode.S);
      const currentSpeed = vec3.length(this.currentVelocity);
      if (
        this.isGrounded &&
        currentSpeed >= this.slideSpeedThreshold &&
        isMovingForward &&
        !isMovingLeft &&
        !isMovingRight &&
        !isMovingBackward
      ) {
        this.startSlide();
      }
    }

    // Update slide state
    if (this.isSliding) {
      this.updateSlide(deltaTime);

      // Terminar slide solo si:
      // 1. Ha pasado el tiempo mínimo Y (soltamos tecla O se acabó tiempo O velocidad baja)
      // 2. O perdemos contacto con el suelo (cancelación forzada)
      const minDurationPassed = this.slideTimer >= this.slideMinDuration;
      const shouldEndSlide =
        !input.isKeyPressed(KeyCode.SHIFT) ||
        this.slideTimer >= this.slideDecelerationTime ||
        vec3.length(this.slideVelocity) < 0.5;

      if (!this.isGrounded || (minDurationPassed && shouldEndSlide)) {
        this.endSlide();
      }
    }
  }

  private manageMovement(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;
    const verticalVelocity = this.currentVelocity[1];
    this.currentVelocity[1] = 0; // Ignorar componente Y para cálculos horizontales

    if (this.isGrounded) {
      // EN SUELO: Control normal con aceleración suave
      if (hasInput) {
        vec3.scale(targetMovement, targetMovement, this.moveSpeed);
        const smoothFactor = Math.min(1.0, deltaTime * this.accelerationFactor);
        const t = Math.pow(smoothFactor, 0.5);
        vec3.lerp(this.currentVelocity, this.currentVelocity, targetMovement, t);
      } else {
        // Deceleración en suelo
        const smoothFactor = Math.min(1.0, deltaTime * this.decelerationFactor);
        const t = 1.0 - Math.pow(1.0 - smoothFactor, 5.0);
        vec3.scale(this.currentVelocity, this.currentVelocity, 1.0 - t);

        if (vec3.length(this.currentVelocity) < 0.01) {
          vec3.set(this.currentVelocity, 0, 0, 0);
        }
      }
    } else if (!this.isSliding && !this.isGrounded) {
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
          this.currentVelocity,
          this.currentVelocity,
          vec3.scale(vec3.create(), correctionVelocity, deltaTime),
        );

        // Limitar la velocidad máxima para evitar aceleración infinita
        const currentSpeed = vec3.length(this.currentVelocity);
        const maxAirSpeed = this.moveSpeed * 1.1; // 10% más rápido que en suelo
        if (currentSpeed > maxAirSpeed) {
          vec3.normalize(this.currentVelocity, this.currentVelocity);
          vec3.scale(this.currentVelocity, this.currentVelocity, maxAirSpeed);
        }
      } else {
        // Sin input en el aire: mantener momentum (casi sin deceleración)
        // Solo una deceleración mínima por resistencia del aire
        const airDrag = 0.04; // 2% de drag por segundo
        const dragFactor = Math.pow(1.0 - airDrag, deltaTime);
        vec3.scale(this.currentVelocity, this.currentVelocity, dragFactor);
      }
    }

    this.currentVelocity[1] = verticalVelocity; // Preservar velocidad vertical
  }

  /**
   * Aplica movimiento horizontal preservando velocidad vertical (gravedad)
   */
  private applyMovement(velocity: vec3, dt: number): void {
    const movement = vec3.fromValues(velocity[0] * dt, velocity[1] * dt, velocity[2] * dt);

    this.characterController.computeColliderMovement(
      this.capsuleCollider.getCollider(),
      new RAPIER.Vector3(movement[0], movement[1], movement[2]),
    );

    this.isGrounded = this.isGrounded = this.capsuleCollider.raycastGrounded(0.1); //this.characterController.computedGrounded();
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
      const isFloor = collision.normal1.y > 0.6;

      // Si es suelo → ignorar completamente para lógica de pared
      if (isFloor) continue;

      if (type === RAPIER.RigidBodyType.Fixed) {
        this.removeVelocityIntoWall(collision.normal1);
      }
    }
  }

  private removeVelocityIntoWall(collisionNormal: RAPIER.Vector3): void {
    const dot =
      this.currentVelocity[0] * collisionNormal.x +
      this.currentVelocity[1] * collisionNormal.y +
      this.currentVelocity[2] * collisionNormal.z;

    // si el vector apunta hacia la pared (dot < 0):
    if (dot < 0) {
      this.currentVelocity[0] -= dot * collisionNormal.x;
      this.currentVelocity[1] -= dot * collisionNormal.y;
      this.currentVelocity[2] -= dot * collisionNormal.z;
    }
  }

  private manageJump(deltaTime: number): void {
    const input = Engine.getInput();
    const canGroundJump =
      !this.isSliding &&
      !this.isJumping &&
      (this.timeSinceGrounded <= this.coyoteTime || this.isGrounded);

    // Update coyote time
    if (this.isGrounded) {
      this.timeSinceGrounded = 0.0;
    } else {
      this.timeSinceGrounded += deltaTime;
    }

    // Detectar inicio del salto
    if (input.isKeyJustPressed(KeyCode.SPACE)) {
      if (canGroundJump) {
        this.applyJump();
        this.isJumping = true; // Iniciar salto variable
        this.timeSinceGrounded = this.coyoteTime + 1.0; // Invalidar coyote time después del salto
        this.jumpHoldTimer = 0.0; // Reset jump hold timer
        this.jumpCutFactorApplied = false;
      }
    } else if (
      this.isJumping &&
      input.isKeyPressed(KeyCode.SPACE) &&
      this.currentVelocity[1] > 0 &&
      this.jumpHoldTimer < this.jumpHoldThreshold
    ) {
      // Variable Jump Height: Aplicar impulso extra mientras se mantiene el botón y el personaje sube
      // Aplicar fuerza adicional mientras se mantiene presionado (acelera hacia arriba)
      this.currentVelocity[1] += this.jumpHoldForce * deltaTime;
      this.jumpHoldTimer += deltaTime;
      if (this.jumpHoldTimer > this.jumpHoldThreshold) {
        this.isJumping = false; // Terminar salto variable después del tiempo máximo
      }
    } else if (
      this.isJumping &&
      !input.isKeyPressed(KeyCode.SPACE) &&
      this.currentVelocity[1] > 0 &&
      !this.jumpCutFactorApplied
    ) {
      this.currentVelocity[1] *= this.jumpCutFactor; // Reducir velocidad vertical al soltar la tecla
      this.jumpCutFactorApplied = true;
    }
  }

  /**
   * Aplica impulso de salto
   */
  private applyJump(): void {
    this.currentVelocity[1] = this.jumpForce;
  }

  /**
   * Inicia el slide
   */
  private startSlide(): void {
    this.isSliding = true;
    this.slideTimer = 0.0;
    // Capturar velocidad actual para el slide
    vec3.copy(this.slideVelocity, this.currentVelocity);

    // Reducir altura del collider
    const newHeight = this.originalHeight * this.slideHeightMultiplier;
    this.applyCapsuleHeight(newHeight);
  }

  /**
   * Actualiza el slide cada frame
   */
  private updateSlide(deltaTime: number): void {
    this.slideTimer += deltaTime;

    // Decelerar progresivamente el slide
    const t = Math.min(1.0, this.slideTimer / this.slideDecelerationTime);
    const decelCurve = 1.0 - Math.pow(t, 2.5); // Curva cuadrática de frenado

    // Aplicar deceleración manteniendo dirección
    const slideSpeed = vec3.length(this.slideVelocity) * decelCurve;
    const slideDirection = vec3.normalize(vec3.create(), this.slideVelocity);
    vec3.scale(this.slideVelocity, slideDirection, slideSpeed);
  }

  /**
   * Termina el slide y restaura el collider
   */
  private endSlide(): void {
    if (!this.isSliding) return;
    this.isSliding = false;
    this.slideTimer = 0.0;

    // Restaurar altura original del collider
    this.applyCapsuleHeight(this.originalHeight);

    // Transferir velocidad del slide al movimiento normal
    vec3.copy(this.currentVelocity, this.slideVelocity);
  }

  /**
   * Redimensiona la cápsula del collider
   */
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

  public override renderInMenu(): void {}

  /**
   * Obtiene la velocidad horizontal actual del personaje (para head bob, efectos de sonido, etc.)
   * @returns Magnitud de la velocidad horizontal en m/s
   */
  public getCurrentSpeed(): number {
    // Retornar la magnitud de la velocidad horizontal (ignorar Y)
    const horizontalVelocity = vec3.fromValues(this.currentVelocity[0], 0, this.currentVelocity[2]);
    return vec3.length(horizontalVelocity);
  }

  /**
   * Obtiene la velocidad máxima de movimiento configurada
   * @returns Velocidad máxima (m/s)
   */
  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  /**
   * Obtiene si el personaje está en el suelo
   * @returns true si está en el suelo
   */
  public getIsGrounded(): boolean {
    return this.isGrounded;
  }

  /**
   * Obtiene si el personaje está haciendo slide
   * @returns true si está en slide
   */
  public getIsSliding(): boolean {
    return this.isSliding;
  }

  /**
   * Obtiene si el personaje está en una pared
   * @returns true si está tocando una pared
   */
  public getIsOnWall(): boolean {
    return this.isOnWall;
  }

  public renderDebug(): void {
    // TODO: Render debug info
    // - Draw grounded raycast
    // - Show velocity vector
  }

  public dispose(): void {
    // Cleanup if needed
  }
}
