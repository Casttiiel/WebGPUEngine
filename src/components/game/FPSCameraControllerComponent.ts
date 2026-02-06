import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { CameraComponent } from '../render/CameraComponent';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { HeadBobComponent } from './HeadBobComponent';
import { HeadTiltComponent } from './HeadTiltComponent';

export interface FPSCameraComponentData {
  eyeOffset?: number[]; // [x, y, z] - Offset de los ojos relativo al owner (ej: [0, 1.6, 0])
  mouseSensitivity?: number; // Sensibilidad del mouse
  invertY?: boolean; // Invertir eje Y (típico en FPS de consola)
}

/**
 * FPSCameraComponent - First Person Camera
 *
 * Sistema de cámara optimizado para FPS:
 * - Cámara posicionada directamente en los ojos del personaje
 * - Control directo de pitch/yaw con mouse
 * - Sin smoothing (respuesta instantánea típica de FPS)
 * - Pitch limitado para evitar gimbal lock
 */
export class FPSCameraControllerComponent extends Component {
  // Configuración
  private eyeOffset: vec3 = vec3.fromValues(0, 1.6, 0); // Altura de ojos (1.6m = típico humano)
  private mouseSensitivity: number = 0.3; // Sensibilidad más alta para FPS
  private invertY: boolean = false; // Invertir eje Y

  // Estado de rotación
  private pitch: number = 0; // Rotación vertical (arriba/abajo)
  private yaw: number = 0; // Rotación horizontal (izquierda/derecha)

  // Referencias
  private cameraEntity: Entity | null = null;
  private isActive: boolean = true;

  constructor() {
    super();
  }

  public async load(data: FPSCameraComponentData): Promise<void> {
    if (data.eyeOffset && data.eyeOffset.length === 3) {
      vec3.set(this.eyeOffset, data.eyeOffset[0]!, data.eyeOffset[1]!, data.eyeOffset[2]!);
    }
    if (data.mouseSensitivity !== undefined) {
      this.mouseSensitivity = data.mouseSensitivity;
    }
    if (data.invertY !== undefined) {
      this.invertY = data.invertY;
    }
  }

  public update(dt: number): void {
    if (!this.isActive) return;

    // Buscar cámara hija (lazy search)
    if (!this.cameraEntity) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        if (child.hasComponent('camera')) {
          this.cameraEntity = child;
          break;
        }
      }

      if (!this.cameraEntity) {
        console.warn('FPSCameraComponent: No camera found in children');
        return;
      }
    }

    const ownerTransform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!ownerTransform) return;

    const cameraComponent = this.cameraEntity.getComponent('camera') as CameraComponent;
    if (!cameraComponent) return;

    // Mouse look control
    const input = Engine.getInput();
    const mouseDelta = input.getMouseDelta();

    // Actualizar rotación (sin smoothing para FPS)
    this.yaw -= mouseDelta.x * this.mouseSensitivity;
    this.pitch += mouseDelta.y * this.mouseSensitivity * (this.invertY ? -1 : 1);

    // Limitar pitch (evitar gimbal lock)
    this.pitch = Math.max(-89, Math.min(89, this.pitch));

    // Calcular dirección de mirada desde pitch/yaw
    const yawRadians = (this.yaw * Math.PI) / 180;
    const pitchRadians = (this.pitch * Math.PI) / 180;

    // Dirección forward usando coordenadas esféricas
    const forward = vec3.fromValues(
      Math.cos(pitchRadians) * Math.sin(yawRadians),
      Math.sin(pitchRadians),
      Math.cos(pitchRadians) * Math.cos(yawRadians),
    );

    // Calcular vectores de la cámara (right, up, forward)
    const worldUp = vec3.fromValues(0, 1, 0);
    const right = vec3.cross(vec3.create(), forward, worldUp);
    vec3.normalize(right, right);
    const up = vec3.cross(vec3.create(), right, forward);
    vec3.normalize(up, up);

    // Calcular posición de la cámara (ojos del personaje)
    const ownerWorldPos = ownerTransform.getTransform().getWorldPosition();
    const eyePos = vec3.add(vec3.create(), ownerWorldPos, this.eyeOffset);

    // Aplicar head bob si el componente está presente
    const headBobComponent = this.getOwner().getComponent('head_bob');
    if (headBobComponent) {
      const bobOffsetWorld = (headBobComponent as HeadBobComponent).getHeadBobOffsetWorld(
        right,
        up,
      );
      vec3.add(eyePos, eyePos, bobOffsetWorld);
    }

    // Aplicar head tilt como rotación roll si el componente está presente
    let roll = 0;
    const headTiltComponent = this.getOwner().getComponent('head_tilt');
    if (headTiltComponent) {
      // El offset del tilt es en radianes (roll)
      roll = (headTiltComponent as HeadTiltComponent).getTiltOffset?.() ?? 0;
    }

    // Calcular forward y up con roll aplicado
    let finalForward = vec3.clone(forward);
    let finalUp = vec3.clone(up);
    if (roll !== 0) {
      // Rotar up y right alrededor de forward (roll)
      const cosR = Math.cos(roll);
      const sinR = Math.sin(roll);
      // up' = up * cos(roll) + right * sin(roll)
      // right' = right * cos(roll) - up * sin(roll)
      const upRot = vec3.create();
      vec3.scale(upRot, up, cosR);
      vec3.scaleAndAdd(upRot, upRot, right, sinR);
      // vec3.scale(rightRot, right, cosR);
      // vec3.scaleAndAdd(rightRot, rightRot, up, -sinR);
      finalUp = upRot;
    }

    // Punto de mira (1 metro adelante de la cámara)
    const lookAtTarget = vec3.add(vec3.create(), eyePos, finalForward);

    // Actualizar cámara directamente (sin TransformComponent)
    const camera = cameraComponent.getCamera();
    camera.lookAt(
      Array.from(eyePos) as [number, number, number],
      Array.from(lookAtTarget) as [number, number, number],
      Array.from(finalUp) as [number, number, number],
    );
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'game';
    const subfolderKey = 'FPS Camera';

    const self = this;

    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Eye Offset X, Y, Z
    const eyeOffsetWrapper = {
      get x() {
        return self.eyeOffset[0];
      },
      set x(value) {
        self.eyeOffset[0] = value;
      },
      get y() {
        return self.eyeOffset[1];
      },
      set y(value) {
        self.eyeOffset[1] = value;
      },
      get z() {
        return self.eyeOffset[2];
      },
      set z(value) {
        self.eyeOffset[2] = value;
      },
    };

    addControl(eyeOffsetWrapper, 'x', 'Eye Offset X', { min: -2, max: 2, step: 0.1 });
    addControl(eyeOffsetWrapper, 'y', 'Eye Offset Y', { min: 0, max: 3, step: 0.1 });
    addControl(eyeOffsetWrapper, 'z', 'Eye Offset Z', { min: -2, max: 2, step: 0.1 });

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

    // Invert Y
    const invertYWrapper = {
      get invertY() {
        return self.invertY;
      },
      set invertY(value) {
        self.invertY = value;
      },
    };

    addControl(invertYWrapper, 'invertY', 'Invert Y');

    // Current angles (read-only)
    const anglesWrapper = {
      get pitch() {
        return self.pitch;
      },
      get yaw() {
        return self.yaw;
      },
    };

    addControl(anglesWrapper, 'pitch', 'Pitch (°)', { readonly: true });
    addControl(anglesWrapper, 'yaw', 'Yaw (°)', { readonly: true });
  }

  public renderDebug(): void {
    // TODO: Visualización debug
    // - Crosshair
    // - Dirección de mirada
  }

  public dispose(): void {
    // Limpieza si es necesario
  }

  public setActive(active: boolean): void {
    this.isActive = active;
  }

  public getEyeOffset(): vec3 {
    return this.eyeOffset;
  }
}
