import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

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
    if (!this.cameraEntity) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        if (child.hasComponent('camera')) {
          this.cameraEntity = child;
          break;
        }
      }
      if (!this.cameraEntity) return;
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!ownerTransform) return;

    const cameraTransform = this.cameraEntity.getComponent('transform') as TransformComponent;
    const cameraComponent = this.cameraEntity.getComponent('camera') as CameraComponent;
    if (!cameraTransform || !cameraComponent) return;

    // --- Mouse look ---
    const input = Engine.getInput();
    const mouseDelta = input.getMouseDelta();

    this.yaw -= mouseDelta.x * this.mouseSensitivity;
    this.pitch += mouseDelta.y * this.mouseSensitivity;
    this.pitch = Math.max(-89, Math.min(89, this.pitch));

    // Rotar el owner en Y (para que el personaje gire con la cámara)
    const ownerAngles = ownerTransform.getTransform().getAngles();
    ownerTransform.getTransform().setAngles(this.yaw, ownerAngles.pitch, ownerAngles.roll);

    // --- Pivot: punto alrededor del cual orbita la cámara ---
    const ownerWorldPos = ownerTransform.getTransform().getWorldPosition();
    const pivot = vec3.add(vec3.create(), ownerWorldPos, this.targetOffset);
    //                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    // targetOffset es el punto de interés (ej. [0,1.5,0] = altura de la cabeza)

    // --- Calcular posición de la cámara orbitando alrededor del pivot ---
    const pitchRad = (this.pitch * Math.PI) / 180;
    const yawRad = (this.yaw * Math.PI) / 180;

    // El offset define la distancia del brazo. Usamos su longitud como radio
    // y su dirección inicial como referencia, luego la rotamos con pitch+yaw.
    const armLength = vec3.length(this.offset); // distancia cámara-pivot

    // Posición de la cámara = pivot + dirección_rotada * armLength
    // La dirección viene de rotar [0,0,-1] (detrás del pivot) con pitch+yaw
    const camOffset = vec3.fromValues(
      -Math.cos(pitchRad) * Math.sin(yawRad) * armLength,
      Math.sin(pitchRad) * armLength,
      -Math.cos(pitchRad) * Math.cos(yawRad) * armLength,
    );

    const desiredPos = vec3.add(vec3.create(), pivot, camOffset);

    // --- Colisión (opcional) ---
    let finalPos = vec3.clone(desiredPos);
    if (this.enableCollision) {
      finalPos = this.applyCollision(pivot, desiredPos);
    }

    // --- Suavizado ---
    if (this.isFirstFrame) {
      vec3.copy(this.currentPosition, finalPos);
      this.isFirstFrame = false;
    } else {
      const alpha = Math.min(1.0, dt * this.smoothSpeed);
      vec3.lerp(this.currentPosition, this.currentPosition, finalPos, alpha);
    }

    // --- Posicionar cámara ---
    cameraTransform.getTransform().setWorldPosition(this.currentPosition);

    // --- Orientar cámara: siempre mirando al pivot ---
    const camera = cameraComponent.getCamera();
    camera.lookAt(
      Array.from(this.currentPosition) as [number, number, number],
      Array.from(pivot) as [number, number, number], // ← siempre mira al pivot
      [0, 1, 0],
    );
  }

  /**
   * Aplica detección de colisión usando raycast
   * Si hay obstáculos entre el owner y la posición deseada, acerca la cámara
   */
  private applyCollision(pivot: vec3, desiredPos: vec3): vec3 {
    const physics = Engine.getPhysics();
    if (!physics) return desiredPos;

    const direction = vec3.subtract(vec3.create(), desiredPos, pivot);
    const distance = vec3.length(direction);
    vec3.normalize(direction, direction);

    const ray = new RAPIER.Ray(
      { x: pivot[0], y: pivot[1], z: pivot[2] }, // ← origen en pivot, no en ownerPos
      { x: direction[0], y: direction[1], z: direction[2] },
    );

    const capsule = this.getOwner().getComponent('capsule_collider') as any;
    const playerRigidBody = capsule?.getRigidBody?.() ?? undefined;

    const hit = physics
      .getWorld()
      .castRay(ray, distance, true, QueryFilterFlags.EXCLUDE_SENSORS, undefined, playerRigidBody);

    if (hit) {
      const safeDistance = Math.max(0.1, hit.timeOfImpact - this.collisionRadius);
      return vec3.scaleAndAdd(vec3.create(), pivot, direction, safeDistance);
    }

    return desiredPos;
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug
    // - Línea desde owner hasta cámara
    // - Punto de target
    // - Raycast de colisión
  }

  public setActive(isActive: boolean): void {
    this.enabled = isActive;
  }

  /**
   * Cleanup de recursos
   */
  public override dispose(): void {
    // Limpieza si es necesario
  }
}
