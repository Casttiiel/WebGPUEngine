import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';
import RAPIER from '@dimforge/rapier3d';

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
  private cameraSearched: boolean = false; // Flag para buscar solo una vez

  // Parámetros de movimiento
  private moveSpeed: number = 5.0; // Unidades por segundo
  private jumpForce: number = 8.0; // Velocidad inicial del salto
  private accelerationTime: number = 1.0; // Tiempo para alcanzar velocidad máxima (segundos)
  private decelerationTime: number = 0.15; // Tiempo para frenar completamente (segundos)
  private airControlMultiplier: number = 0.3; // Control en el aire (0.0 = sin control, 1.0 = control total)

  // Slide parameters
  private slideSpeedThreshold: number = 3.0; // Velocidad mínima para activar slide
  private slideDecelerationTime: number = 1.5; // Tiempo de frenado del slide
  private slideHeightMultiplier: number = 0.5; // Reducción de altura (0.5 = mitad de altura)

  // Wall jump parameters
  private wallJumpForce: number = 8.0; // Fuerza del salto desde la pared (vertical)
  private wallJumpAwayForce: number = 6.0; // Fuerza de empuje horizontal desde la pared
  private wallJumpCooldown: number = 0.3; // Cooldown entre wall jumps (segundos)
  private wallCheckDistance: number = 0.6; // Distancia máxima para detectar pared
  private wallSlideGravityMultiplier: number = 0.3; // Reduce gravedad al deslizar en pared

  // Estado
  private isGrounded: boolean = false;
  private currentVelocity: vec3 = vec3.create(); // Velocidad actual interpolada
  private airVelocity: vec3 = vec3.create(); // Velocidad horizontal al dejar el suelo (momentum preservation)

  // Slide state
  private isSliding: boolean = false;
  private slideVelocity: vec3 = vec3.create(); // Velocidad capturada al inicio del slide
  private slideTimer: number = 0.0; // Tiempo transcurrido en slide
  private originalHeight: number = 0.0; // Altura original del collider
  private originalRadius: number = 0.0; // Radio original del collider

  // Coyote time - permite saltar justo después de dejar el suelo
  private coyoteTime: number = 0.15; // Segundos de gracia después de dejar el suelo
  private timeSinceGrounded: number = 0.0; // Tiempo desde que dejó de estar grounded

  // Wall jump state
  private isOnWall: boolean = false;
  private wallNormal: vec3 = vec3.create(); // Normal de la pared detectada
  private timeSinceWallJump: number = 999.0; // Tiempo desde el último wall jump

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
    if (data.accelerationTime !== undefined) {
      this.accelerationTime = data.accelerationTime;
    }
    if (data.decelerationTime !== undefined) {
      this.decelerationTime = data.decelerationTime;
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
    if (data.wallJumpForce !== undefined) {
      this.wallJumpForce = data.wallJumpForce;
    }
    if (data.wallJumpAwayForce !== undefined) {
      this.wallJumpAwayForce = data.wallJumpAwayForce;
    }
    if (data.wallJumpCooldown !== undefined) {
      this.wallJumpCooldown = data.wallJumpCooldown;
    }
    if (data.wallCheckDistance !== undefined) {
      this.wallCheckDistance = data.wallCheckDistance;
    }
    if (data.wallSlideGravityMultiplier !== undefined) {
      this.wallSlideGravityMultiplier = data.wallSlideGravityMultiplier;
    }

    // Guardar dimensiones originales del collider
    this.originalHeight = this.capsuleCollider.getCapsuleHeight();
    this.originalRadius = this.capsuleCollider.getCapsuleRadius();

    // NO buscar cámara aquí - las entidades hijas aún no están cargadas
    // La buscaremos en el primer update()

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();
  }

  public update(deltaTime: number): void {
    if (!this.capsuleCollider) return;

    this.findCamera();

    // Update coyote time
    if (this.isGrounded) {
      this.timeSinceGrounded = 0.0;
    } else {
      this.timeSinceGrounded += deltaTime;
    }

    // Update wall jump cooldown
    /*this.timeSinceWallJump += deltaTime;

    // Wall detection (solo si no estamos en el suelo)
    if (!this.isGrounded && !this.isSliding) {
      this.checkWallContact();
    } else {
      this.isOnWall = false;
    }*/

    // 2. Handle slide activation and update
    const input = Engine.getInput();
    const currentSpeed = vec3.length(this.currentVelocity);

    if (!this.isSliding && input.isKeyJustPressed(KeyCode.SHIFT)) {
      // Activar slide si estamos en el suelo y con velocidad suficiente
      if (this.isGrounded && currentSpeed >= this.slideSpeedThreshold) {
        this.startSlide();
      }
    }

    // Update slide state
    if (this.isSliding) {
      this.updateSlide(deltaTime);

      // Terminar slide si soltamos la tecla o se acabó el tiempo/velocidad
      if (
        !input.isKeyPressed(KeyCode.SHIFT) ||
        this.slideTimer >= this.slideDecelerationTime ||
        vec3.length(this.slideVelocity) < 0.5 ||
        !this.isGrounded
      ) {
        this.endSlide();
      }
    }

    // 3. Gather input (desactivado durante slide)
    const inputDir = vec3.create();

    if (!this.isSliding) {
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
    } // End !isSliding input block

    // 4. Transform movement to camera space (FPS movement)
    const targetMovement = vec3.create();

    if (!this.isSliding && this.camera) {
      const cameraObj = this.camera.getCamera();
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
    } else if (!this.isSliding) {
      // Fallback to world-space movement if no camera (solo si no está sliding)
      vec3.copy(targetMovement, inputDir);
    }

    // Apply movement speed to get target velocity (solo si no está sliding)
    if (!this.isSliding) {
      vec3.scale(targetMovement, targetMovement, this.moveSpeed);
    }

    // 5. Smooth acceleration/deceleration
    const hasInput = vec3.length(targetMovement) > 0.01;

    if (!this.isSliding && this.isGrounded) {
      // EN SUELO: Control normal con aceleración suave
      if (hasInput) {
        const smoothFactor = Math.min(1.0, deltaTime / this.accelerationTime);
        const t = Math.pow(smoothFactor, 0.5);
        vec3.lerp(this.currentVelocity, this.currentVelocity, targetMovement, t);
      } else {
        // Deceleración en suelo
        const smoothFactor = Math.min(1.0, deltaTime / this.decelerationTime);
        const t = 1.0 - Math.pow(1.0 - smoothFactor, 5.0);
        vec3.scale(this.currentVelocity, this.currentVelocity, 1.0 - t);

        if (vec3.length(this.currentVelocity) < 0.01) {
          vec3.set(this.currentVelocity, 0, 0, 0);
        }
      }
    } else if (!this.isSliding && !this.isGrounded) {
      // EN AIRE: Preservar momentum + pequeñas correcciones
      if (hasInput) {
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
        const maxAirSpeed = this.moveSpeed * 1.2; // 20% más rápido que en suelo
        if (currentSpeed > maxAirSpeed) {
          vec3.normalize(this.currentVelocity, this.currentVelocity);
          vec3.scale(this.currentVelocity, this.currentVelocity, maxAirSpeed);
        }
      } else {
        // Sin input en el aire: mantener momentum (casi sin deceleración)
        // Solo una deceleración mínima por resistencia del aire
        const airDrag = 0.02; // 2% de drag por segundo
        const dragFactor = Math.pow(1.0 - airDrag, deltaTime);
        vec3.scale(this.currentVelocity, this.currentVelocity, dragFactor);
      }
    }

    // 6. Handle jump (con coyote time, wall jump, no durante slide)
    const canGroundJump = this.timeSinceGrounded <= this.coyoteTime && !this.isSliding;
    const canWallJump =
      this.isOnWall && !this.isSliding && this.timeSinceWallJump > this.wallJumpCooldown;

    if (input.isKeyJustPressed(KeyCode.SPACE)) {
      if (canGroundJump) {
        this.applyJump();
        this.timeSinceGrounded = this.coyoteTime + 1.0; // Invalidar coyote time después del salto
      } else if (canWallJump) {
        this.applyWallJump();
      }
    } else {
      // Para cuerpos KINEMATIC, necesitamos simular gravedad manualmente
      const gravity = -9.81; // m/s²

      // Actualizar velocidad vertical con gravedad
      if (!this.isGrounded) {
        this.currentVelocity[1] += gravity * deltaTime;
      } else {
        // En el suelo, resetear velocidad vertical
        if (this.currentVelocity[1] < 0) {
          this.currentVelocity[1] = 0;
        }
      }
    }

    // 6.5. Apply wall slide gravity reduction
    if (this.isOnWall && !this.isGrounded) {
      //this.applyWallSlideGravity();
    }

    // 7. Apply horizontal velocity preservando Y (gravedad)
    const velocityToApply = this.isSliding ? this.slideVelocity : this.currentVelocity;

    this.applyMovement(velocityToApply, deltaTime);
  }

  private findCamera(): void {
    // Lazy camera search: buscar en el primer update cuando los hijos ya están cargados
    if (!this.cameraSearched) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        const cam = child.getComponent('camera') as CameraComponent;
        if (cam) {
          this.camera = cam;
          break;
        }
      }

      if (!this.camera) {
        console.warn(
          'CharacterControllerComponent: No camera found in children. Movement will be world-space.',
        );
      }

      this.cameraSearched = true; // Solo buscar una vez
    }
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

  private removeVelocityIntoWall(collisionNormal) {
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

  /**
   * Detecta si hay una pared cerca usando raycasts
   */
  private checkWallContact(): void {
    if (!this.capsuleCollider.getRigidBody()) return;

    /*const physics = Engine.getPhysics();
    if (!physics) return;

    const translation = this.capsuleCollider.getRigidBody().translation();
    const position = vec3.fromValues(translation.x, translation.y, translation.z);

    const directions = [
      vec3.fromValues(1, 0, 0), // Right
      vec3.fromValues(-1, 0, 0), // Left
      vec3.fromValues(0, 0, 1), // Forward
      vec3.fromValues(0, 0, -1), // Back
    ];

    this.isOnWall = false;

    for (const direction of directions) {
      const rayOrigin = { x: position[0], y: position[1], z: position[2] };
      const rayDir = { x: direction[0], y: direction[1], z: direction[2] };
      const ray = new (window as any).RAPIER.Ray(rayOrigin, rayDir);

      const hit = physics.getWorld().castRay(
        ray,
        this.wallCheckDistance,
        true, // solid
        undefined,
        undefined,
        this.capsuleCollider.getRigidBody().collider(0), // Excluir propio collider
      );

      if (hit) {
        // Obtener normal de la superficie (aproximada como opuesta a la dirección del ray)
        const hitNormal = vec3.fromValues(-direction[0], 0, -direction[2]);
        vec3.normalize(hitNormal, hitNormal);

        const verticalComponent = Math.abs(hitNormal[1]);

        if (verticalComponent < 0.5) {
          // Normal más horizontal que vertical
          this.isOnWall = true;
          vec3.copy(this.wallNormal, hitNormal);
          return; // Encontramos una pared, salir
        }
      }
    }*/
  }

  /**
   * Aplica impulso de salto
   */
  private applyJump(): void {
    this.currentVelocity[1] = this.jumpForce;
  }

  /**
   * Aplica impulso de wall jump (salto desde la pared)
   */
  private applyWallJump(): void {
    // Empuje horizontal alejándose de la pared
    const awayFromWall = vec3.scale(vec3.create(), this.wallNormal, this.wallJumpAwayForce);

    // Velocidad vertical de salto
    const upwardVelocity = vec3.fromValues(0, this.wallJumpForce, 0);

    // Combinar ambas velocidades
    const wallJumpVel = vec3.add(vec3.create(), awayFromWall, upwardVelocity);

    // Aplicar la velocidad
    this.capsuleCollider.setLinearVelocity(wallJumpVel);

    // Actualizar currentVelocity para que el movimiento en aire sea correcto
    vec3.set(this.currentVelocity, wallJumpVel[0], 0, wallJumpVel[2]);

    // Reset wall jump cooldown
    this.timeSinceWallJump = 0.0;
    this.isOnWall = false;

    console.log('Wall jump! Away force:', this.wallJumpAwayForce);
  }

  /**
   * Reduce la gravedad mientras se desliza por una pared
   */
  private applyWallSlideGravity(): void {
    const currentVel = this.capsuleCollider.getLinearVelocity();

    // Solo reducir velocidad de caída, no afectar si ya estamos subiendo
    if (currentVel[1] < 0) {
      const reducedGravity = currentVel[1] * this.wallSlideGravityMultiplier;
      const newVel = vec3.fromValues(currentVel[0], reducedGravity, currentVel[2]);
      this.capsuleCollider.setLinearVelocity(newVel);
    }
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
    this.resizeCapsule(newHeight, this.originalRadius);

    console.log('Slide started!', vec3.length(this.slideVelocity).toFixed(2), 'm/s');
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
    this.resizeCapsule(this.originalHeight, this.originalRadius);

    // Transferir velocidad del slide al movimiento normal
    vec3.copy(this.currentVelocity, this.slideVelocity);

    console.log('Slide ended!');
  }

  /**
   * Redimensiona la cápsula del collider
   */
  private resizeCapsule(newHeight: number, radius: number): void {
    // TODO: Implementar resize del collider en CapsuleColliderComponent
    // Por ahora, esto es placeholder
    // Necesitaremos recrear el collider con las nuevas dimensiones
    console.log(`Resize capsule: height=${newHeight.toFixed(2)}, radius=${radius.toFixed(2)}`);
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
