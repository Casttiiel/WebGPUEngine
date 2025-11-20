import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER from '@dimforge/rapier3d';

export interface CameraArmComponentData {
  targetOffset?: number[]; // [x, y, z] - Posición del target relativo al owner (ej: [0, 1.6, 0] = cabeza)
  distance?: number; // Distancia desde el target hasta la cámara (ej: 5.0 para TPS, 0.0 para FPS)
  smoothSpeed?: number; // Velocidad de interpolación de posición
  rotationSmoothSpeed?: number; // Velocidad de suavizado de rotación (0 = sin suavizado, ej: 10.0)
  enableCollision?: boolean; // Activar raycast de colisión
  collisionRadius?: number; // Radio para el raycast
  mouseSensitivity?: number; // Sensibilidad del mouse para rotación
}

/**
 * CameraArmComponent - Spring Arm / Camera Boom
 *
 * Funcionalidades:
 * - Posiciona la cámara con offset relativo al owner (personaje)
 * - Control de rotación de cámara con mouse (pitch/yaw independientes)
 * - Suavizado de movimiento (interpolación)
 * - Detección de colisión opcional (raycast para evitar atravesar paredes)
 * - NO rota el player entity, solo gestiona la cámara
 */
export class CameraArmComponent extends Component {
  // Configuración
  private targetOffset: vec3 = vec3.fromValues(0, 1.6, 0); // Target a altura de cabeza
  private distance: number = 0.0; // Distancia de cámara al target (0 = FPS)
  private smoothSpeed: number = 10.0; // Interpolación
  private enableCollision: boolean = false; // Colisión con paredes
  private collisionRadius: number = 0.3; // Radio para raycast
  private mouseSensitivity: number = 0.15; // Sensibilidad del mouse

  // Estado interno
  private currentPosition: vec3 = vec3.create();
  private isFirstFrame: boolean = true;
  private pitch: number = 0; // Rotación vertical actual (arriba/abajo)
  private yaw: number = 0; // Rotación horizontal actual (izquierda/derecha)
  private targetPitch: number = 0; // Rotación vertical objetivo
  private targetYaw: number = 0; // Rotación horizontal objetivo
  private rotationSmoothSpeed: number = 0.0; // Suavizado de rotación (0 = instantáneo)

  // Referencias
  private cameraEntity: any = null;

  constructor() {
    super();
  }

  public async load(data: CameraArmComponentData): Promise<void> {
    // Cargar configuración
    if (data.targetOffset && data.targetOffset.length === 3) {
      vec3.set(
        this.targetOffset,
        data.targetOffset[0]!,
        data.targetOffset[1]!,
        data.targetOffset[2]!,
      );
    }
    if (data.distance !== undefined) {
      this.distance = data.distance;
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
    if (data.rotationSmoothSpeed !== undefined) {
      this.rotationSmoothSpeed = data.rotationSmoothSpeed;
    }

    // Inicializar posición actual (se calculará en el primer update)
    vec3.set(this.currentPosition, 0, 0, 0);
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

    const cameraComponent = this.cameraEntity.getComponent('camera') as CameraComponent;
    if (!cameraComponent) return;

    // Mouse look control - SOLO afecta a la cámara, NO al player entity
    const input = Engine.getInput();
    const mouseDelta = input.getMouseDelta();

    // Actualizar rotación objetivo
    this.targetYaw -= mouseDelta.x * this.mouseSensitivity;
    this.targetPitch += mouseDelta.y * this.mouseSensitivity; // Invertido: + para arriba, - para abajo

    // Limitar pitch objetivo (evitar gimbal lock)
    this.targetPitch = Math.max(-89, Math.min(89, this.targetPitch));

    // Aplicar suavizado de rotación (si está habilitado)
    if (this.rotationSmoothSpeed > 0.01) {
      // Suavizado con lerp
      const rotAlpha = Math.min(1.0, dt * this.rotationSmoothSpeed);
      this.yaw += (this.targetYaw - this.yaw) * rotAlpha;
      this.pitch += (this.targetPitch - this.pitch) * rotAlpha;
    } else {
      // Sin suavizado: rotación instantánea
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
    }

    // Obtener posición del owner
    const ownerWorldPos = ownerTransform.getTransform().getWorldPosition();

    // Calcular posición del TARGET (punto al que siempre mira la cámara)
    // El target es relativo al owner (ej: cabeza del personaje)
    const targetPos = vec3.add(vec3.create(), ownerWorldPos, this.targetOffset);

    // Calcular posición de la CÁMARA usando órbita esférica alrededor del target
    // Convertir pitch/yaw a radianes
    const yawRadians = (this.yaw * Math.PI) / 180;
    const pitchRadians = (this.pitch * Math.PI) / 180;

    // Coordenadas esféricas: (distance, pitch, yaw) -> (x, y, z)
    // x = distance * cos(pitch) * sin(yaw)
    // y = distance * sin(pitch)
    // z = distance * cos(pitch) * cos(yaw)
    const cameraOffset = vec3.fromValues(
      this.distance * Math.cos(pitchRadians) * Math.sin(yawRadians),
      this.distance * Math.sin(pitchRadians),
      this.distance * Math.cos(pitchRadians) * Math.cos(yawRadians),
    );

    const desiredPos = vec3.add(vec3.create(), targetPos, cameraOffset); // Aplicar colisión si está habilitado
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

    // Actualizar posición y orientación de la cámara usando directamente Camera.lookAt()
    const camera = cameraComponent.getCamera();

    // La cámara siempre mira al targetPos (cabeza del personaje)
    // Aplicar posición y orientación directamente a la cámara (sin TransformComponent)
    camera.lookAt(
      Array.from(this.currentPosition) as [number, number, number],
      Array.from(targetPos) as [number, number, number],
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

    // Target Offset X, Y, Z
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

    // Distance
    const distanceWrapper = {
      get distance() {
        return self.distance;
      },
      set distance(value) {
        self.distance = value;
      },
    };

    addControl(distanceWrapper, 'distance', 'Distance', { min: 0.0, max: 20.0, step: 0.1 });

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

    // Rotation smooth speed
    const rotationSmoothSpeedWrapper = {
      get rotationSmoothSpeed() {
        return self.rotationSmoothSpeed;
      },
      set rotationSmoothSpeed(value) {
        self.rotationSmoothSpeed = value;
      },
    };

    addControl(rotationSmoothSpeedWrapper, 'rotationSmoothSpeed', 'Rotation Smooth', {
      min: 0.0,
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
