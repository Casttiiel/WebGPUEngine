import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER from '@dimforge/rapier3d';

export interface CameraArmComponentData {
  offset?: number[]; // [x, y, z] - Offset en espacio local
  targetOffset?: number[]; // [x, y, z] - Punto al que mira la cámara (relativo al owner)
  smoothSpeed?: number; // Velocidad de interpolación
  enableCollision?: boolean; // Activar raycast de colisión
  collisionRadius?: number; // Radio para el raycast
  mouseSensitivity?: number; // Sensibilidad del mouse para rotación
}

/**
 * CameraArmComponent - Spring Arm / Camera Boom
 *
 * Funcionalidades:
 * - Posiciona la cámara con offset relativo al owner (personaje)
 * - Control de rotación con mouse (mouse look) opcional
 * - Suavizado de movimiento (interpolación)
 * - Detección de colisión opcional (raycast para evitar atravesar paredes)
 * - Rotación del owner (personaje) en Y basado en mouse X
 *
 * Uso típico (tercera persona):
 * {
 *   "camera_arm": {
 *     "offset": [0, 2.5, -5.0],
 *     "targetOffset": [0, 1.0, 0],
 *     "smoothSpeed": 10.0,
 *     "enableCollision": true,
 *     "enableMouseLook": true,
 *     "mouseSensitivity": 0.2
 *   }
 * }
 *
 * Uso típico (primera persona):
 * {
 *   "camera_arm": {
 *     "offset": [0, 1.6, 0],
 *     "targetOffset": [0, 0, 1],
 *     "smoothSpeed": 15.0,
 *     "enableCollision": false,
 *     "enableMouseLook": true,
 *     "mouseSensitivity": 0.15
 *   }
 * }
 */
export class CameraArmComponent extends Component {
  // Configuración
  private offset: vec3 = vec3.fromValues(0, 1.6, 0); // Primera persona por defecto
  private targetOffset: vec3 = vec3.fromValues(0, 0, 1); // Mira hacia adelante
  private smoothSpeed: number = 10.0; // Interpolación
  private enableCollision: boolean = false; // Colisión con paredes
  private collisionRadius: number = 0.3; // Radio para raycast
  private mouseSensitivity: number = 0.15; // Sensibilidad del mouse

  // Estado interno
  private currentPosition: vec3 = vec3.create();
  private isFirstFrame: boolean = true;
  private pitch: number = 0; // Rotación vertical (arriba/abajo)
  private yaw: number = 0; // Rotación horizontal (izquierda/derecha)

  // Referencias
  private cameraEntity: any = null;

  constructor() {
    super();
  }

  public async load(data: CameraArmComponentData): Promise<void> {
    // Cargar configuración
    if (data.offset && data.offset.length === 3) {
      vec3.set(this.offset, data.offset[0]!, data.offset[1]!, data.offset[2]!);
    }
    if (data.targetOffset && data.targetOffset.length === 3) {
      vec3.set(
        this.targetOffset,
        data.targetOffset[0]!,
        data.targetOffset[1]!,
        data.targetOffset[2]!,
      );
    }
    if (data.smoothSpeed !== undefined) {
      this.smoothSpeed = data.smoothSpeed;
    }
    if (data.enableCollision !== undefined) {
      this.enableCollision = data.enableCollision;
    }
    if (data.collisionRadius !== undefined) {
      this.collisionRadius = data.collisionRadius;
    }
    if (data.mouseSensitivity !== undefined) {
      this.mouseSensitivity = data.mouseSensitivity;
    }

    // Inicializar posición actual
    vec3.copy(this.currentPosition, this.offset);
  }

  public update(dt: number): void {
    // Buscar cámara hija (lazy search, igual que CharacterController)
    if (!this.cameraEntity) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        if (child.hasComponent('camera')) {
          this.cameraEntity = child;
          console.log('CameraArmComponent: Camera found in children!');
          break;
        }
      }

      if (!this.cameraEntity) {
        console.warn('CameraArmComponent: No camera found in children');
        return;
      }
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!ownerTransform) return;

    const cameraTransform = this.cameraEntity.getComponent('transform') as TransformComponent;
    const cameraComponent = this.cameraEntity.getComponent('camera') as CameraComponent;
    if (!cameraTransform || !cameraComponent) return;

    // Mouse look control
    const input = Engine.getInput();
    const mouseDelta = input.getMouseDelta();

    // Actualizar yaw (rotación horizontal) y pitch (rotación vertical)
    this.yaw -= mouseDelta.x * this.mouseSensitivity;
    this.pitch -= mouseDelta.y * this.mouseSensitivity;

    // Limitar pitch (evitar gimbal lock)
    this.pitch = Math.max(-89, Math.min(89, this.pitch));

    // Aplicar yaw al owner (rotar personaje en Y)
    const ownerAngles = ownerTransform.getTransform().getAngles();
    ownerTransform.getTransform().setAngles(this.yaw, ownerAngles.pitch, ownerAngles.roll);

    // Obtener posición y rotación del owner
    const ownerWorldPos = ownerTransform.getTransform().getWorldPosition();
    const ownerWorldMatrix = ownerTransform.getTransform().getWorldMatrix();

    // Calcular posición deseada de la cámara (offset en espacio local del owner)
    const desiredPos = vec3.transformMat4(vec3.create(), this.offset, ownerWorldMatrix);

    // Aplicar colisión si está habilitado
    let finalPos = vec3.clone(desiredPos);
    if (this.enableCollision) {
      finalPos = this.applyCollision(ownerWorldPos, desiredPos);
    }

    // Suavizado de posición (lerp)
    if (this.isFirstFrame) {
      // Primera vez: posicionar directamente sin interpolación
      vec3.copy(this.currentPosition, finalPos);
      this.isFirstFrame = false;
    } else {
      // Interpolación suave
      const alpha = Math.min(1.0, dt * this.smoothSpeed);
      vec3.lerp(this.currentPosition, this.currentPosition, finalPos, alpha);
    }

    // Actualizar posición de la cámara
    cameraTransform.getTransform().setWorldPosition(this.currentPosition);

    // Actualizar orientación de la cámara usando pitch/yaw
    const camera = cameraComponent.getCamera();

    // Calcular dirección de la cámara usando pitch y yaw
    const pitchRad = (this.pitch * Math.PI) / 180;
    const yawRad = (this.yaw * Math.PI) / 180;

    // Calcular vector de dirección desde pitch/yaw
    const forward = vec3.fromValues(
      Math.cos(pitchRad) * Math.sin(yawRad),
      Math.sin(pitchRad),
      Math.cos(pitchRad) * Math.cos(yawRad),
    );

    // Target = posición de cámara + forward
    const target = vec3.add(vec3.create(), this.currentPosition, forward);

    camera.lookAt(
      Array.from(this.currentPosition) as [number, number, number],
      Array.from(target) as [number, number, number],
      [0, 1, 0],
    );
  }

  /**
   * Aplica detección de colisión usando raycast
   * Si hay obstáculos entre el owner y la posición deseada, acerca la cámara
   */
  private applyCollision(ownerPos: vec3, desiredPos: vec3): vec3 {
    const physics = Engine.getPhysics();
    if (!physics) return desiredPos;

    // Dirección y distancia del raycast
    const direction = vec3.subtract(vec3.create(), desiredPos, ownerPos);
    const distance = vec3.length(direction);
    vec3.normalize(direction, direction);

    // Crear ray desde el owner hacia la posición deseada
    const ray = new RAPIER.Ray(
      { x: ownerPos[0], y: ownerPos[1], z: ownerPos[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );

    // Raycast para detectar obstáculos
    const hit = physics.getWorld().castRay(
      ray,
      distance,
      true, // solid
      undefined, // sin filtro de flags
      undefined, // sin filtro de grupos
      undefined, // no excluir ningún collider
    );

    if (hit) {
      // Hay colisión: acercar la cámara al punto de impacto
      const hitDistance = hit.timeOfImpact - this.collisionRadius; // Dejar un margen
      const safeDistance = Math.max(0.1, hitDistance); // Mínimo 0.1 unidades

      const adjustedPos = vec3.scaleAndAdd(vec3.create(), ownerPos, direction, safeDistance);

      return adjustedPos;
    }

    // Sin colisión: usar posición deseada
    return desiredPos;
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'game';
    const subfolderKey = 'Camera Arm';

    const self = this;

    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Offset X, Y, Z
    const offsetWrapper = {
      get x() {
        return self.offset[0];
      },
      set x(value) {
        self.offset[0] = value;
      },
      get y() {
        return self.offset[1];
      },
      set y(value) {
        self.offset[1] = value;
      },
      get z() {
        return self.offset[2];
      },
      set z(value) {
        self.offset[2] = value;
      },
    };

    addControl(offsetWrapper, 'x', 'Offset X', { min: -10, max: 10, step: 0.1 });
    addControl(offsetWrapper, 'y', 'Offset Y', { min: -10, max: 10, step: 0.1 });
    addControl(offsetWrapper, 'z', 'Offset Z', { min: -10, max: 10, step: 0.1 });

    // Target Offset
    const targetOffsetWrapper = {
      get x() {
        return self.targetOffset[0];
      },
      set x(value) {
        self.targetOffset[0] = value;
      },
      get y() {
        return self.targetOffset[1];
      },
      set y(value) {
        self.targetOffset[1] = value;
      },
      get z() {
        return self.targetOffset[2];
      },
      set z(value) {
        self.targetOffset[2] = value;
      },
    };

    addControl(targetOffsetWrapper, 'x', 'Target X', { min: -10, max: 10, step: 0.1 });
    addControl(targetOffsetWrapper, 'y', 'Target Y', { min: -10, max: 10, step: 0.1 });
    addControl(targetOffsetWrapper, 'z', 'Target Z', { min: -10, max: 10, step: 0.1 });

    // Smooth speed
    const smoothSpeedWrapper = {
      get smoothSpeed() {
        return self.smoothSpeed;
      },
      set smoothSpeed(value) {
        self.smoothSpeed = value;
      },
    };

    addControl(smoothSpeedWrapper, 'smoothSpeed', 'Smooth Speed', {
      min: 0.1,
      max: 50.0,
      step: 0.1,
    });

    // Mouse sensitivity
    const mouseSensitivityWrapper = {
      get mouseSensitivity() {
        return self.mouseSensitivity;
      },
      set mouseSensitivity(value) {
        self.mouseSensitivity = value;
      },
    };

    addControl(mouseSensitivityWrapper, 'mouseSensitivity', 'Mouse Sensitivity', {
      min: 0.01,
      max: 1.0,
      step: 0.01,
    });

    // Enable collision
    const collisionWrapper = {
      get enableCollision() {
        return self.enableCollision;
      },
      set enableCollision(value) {
        self.enableCollision = value;
      },
    };

    addControl(collisionWrapper, 'enableCollision', 'Enable Collision');
  }

  public renderDebug(): void {
    // TODO: Visualización debug
    // - Línea desde owner hasta cámara
    // - Punto de target
    // - Raycast de colisión
  }

  /**
   * Cleanup de recursos
   */
  public dispose(): void {
    // Limpieza si es necesario
  }
}
