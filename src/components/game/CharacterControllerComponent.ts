import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { CharacterControllerComponentDataType } from '../../types/CharacterControllerComponentData.type';

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
  private camera: CameraComponent | null = null;
  private cameraSearched: boolean = false; // Flag para buscar solo una vez

  // Parámetros de movimiento
  private moveSpeed: number = 5.0; // Unidades por segundo
  private jumpForce: number = 8.0; // Velocidad inicial del salto

  // Estado
  private isGrounded: boolean = false;

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

    // NO buscar cámara aquí - las entidades hijas aún no están cargadas
    // La buscaremos en el primer update()
  }

  public update(_deltaTime: number): void {
    if (!this.capsuleCollider) return;

    // Lazy camera search: buscar en el primer update cuando los hijos ya están cargados
    if (!this.cameraSearched) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        const cam = child.getComponent('camera') as CameraComponent;
        if (cam) {
          this.camera = cam;
          console.log('CharacterControllerComponent: Camera found in children!');
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

    // 1. Check if grounded usando el método del collider
    this.isGrounded = this.capsuleCollider.raycastGrounded(0.1);

    // 2. Gather input
    const input = Engine.getInput();
    const inputDir = vec3.create();

    // WASD input (local space)
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

    // 3. Transform movement to camera space (FPS movement)
    const movement = vec3.create();

    if (this.camera) {
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

      vec3.add(movement, forwardMovement, rightMovement);

      // Normalize final movement
      if (vec3.length(movement) > 0.01) {
        vec3.normalize(movement, movement);
      }
    } else {
      // Fallback to world-space movement if no camera
      vec3.copy(movement, inputDir);
    }

    // Apply movement speed
    vec3.scale(movement, movement, this.moveSpeed);

    // 4. Handle jump
    if (this.isGrounded && input.isKeyPressed(KeyCode.SPACE)) {
      this.applyJump();
    }

    // 5. Apply horizontal velocity preservando Y (gravedad)
    this.applyMovement(movement);
  }

  /**
   * Aplica movimiento horizontal preservando velocidad vertical (gravedad)
   */
  private applyMovement(horizontalMovement: vec3): void {
    const currentVel = this.capsuleCollider.getLinearVelocity();

    // Preservar Y (gravedad), aplicar X/Z (movimiento)
    const newVel = vec3.fromValues(
      horizontalMovement[0],
      currentVel[1], // ✅ Preservar velocidad vertical
      horizontalMovement[2],
    );

    this.capsuleCollider.setLinearVelocity(newVel);
  }

  /**
   * Aplica impulso de salto
   */
  private applyJump(): void {
    const currentVel = this.capsuleCollider.getLinearVelocity();

    // Aplicar velocidad vertical de salto
    const jumpVel = vec3.fromValues(currentVel[0], this.jumpForce, currentVel[2]);

    this.capsuleCollider.setLinearVelocity(jumpVel);
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'game';
    const subfolderKey = 'Character Controller';

    const self = this;

    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Move speed
    const moveSpeedWrapper = {
      get moveSpeed() {
        return self.moveSpeed;
      },
      set moveSpeed(value) {
        self.moveSpeed = value;
      },
    };

    addControl(moveSpeedWrapper, 'moveSpeed', 'Move Speed', {
      min: 0.1,
      max: 20.0,
      step: 0.1,
    });

    // Jump force
    const jumpForceWrapper = {
      get jumpForce() {
        return self.jumpForce;
      },
      set jumpForce(value) {
        self.jumpForce = value;
      },
    };

    addControl(jumpForceWrapper, 'jumpForce', 'Jump Force', {
      min: 1.0,
      max: 20.0,
      step: 0.1,
    });

    // Debug info (read-only)
    const groundedWrapper = {
      get isGrounded() {
        return self.isGrounded ? 'Yes' : 'No';
      },
    };

    debugUI.addDebugControl(parentFolder, groundedWrapper, 'isGrounded', 'Grounded');

    const verticalVelWrapper = {
      get verticalVelocity() {
        if (!self.capsuleCollider) return '0.00';
        const rigidBody = self.capsuleCollider.getRigidBody();
        if (!rigidBody) return '0.00';
        const velocity = rigidBody.linvel();
        return velocity.y.toFixed(2);
      },
    };

    debugUI.addDebugControl(
      parentFolder,
      verticalVelWrapper,
      'verticalVelocity',
      'Vertical Velocity (Physics)',
    );
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
