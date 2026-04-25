import { Component } from '../../core/ecs/Component';
import { ParkourControllerComponent } from './ParkourControllerComponent';
import { FPSCameraControllerComponent } from './FPSCameraControllerComponent';

export interface CameraCrouchComponentData {
  slideCrouchHeight?: number; // Altura de la cámara durante slide (ej: 0.3)
  crouchSpeed?: number; // Velocidad de interpolación al agacharse (ej: 8.0)
  enabled?: boolean; // Activar/desactivar el efecto
}

/**
 * CameraCrouchComponent - Camera Height Animation
 *
 * Anima la altura de la cámara basándose en el estado del personaje:
 * - Baja durante slide
 * - Puede extenderse para crouch manual, prone, etc.
 *
 * Requiere:
 * - FPSCameraControllerComponent en el mismo owner
 * - CharacterControllerComponent en el mismo owner
 */
export class CameraCrouchComponent extends Component {
  // Configuración
  private slideCrouchHeight: number = 0.3; // Altura durante slide (metros)
  private crouchSpeed: number = 8.0; // Velocidad de interpolación
  public override enabled: boolean = true;

  // Estado
  private baseEyeHeight: number = 0.8; // Altura base (capturada del FPSCamera)
  private currentEyeHeight: number = 0.8; // Altura actual interpolada
  private initialized: boolean = false;

  // Referencias
  private fpsCamera: FPSCameraControllerComponent | null = null;

  constructor() {
    super();
  }

  public async load(data: CameraCrouchComponentData): Promise<void> {
    if (data.slideCrouchHeight !== undefined) {
      this.slideCrouchHeight = data.slideCrouchHeight;
    }
    if (data.crouchSpeed !== undefined) {
      this.crouchSpeed = data.crouchSpeed;
    }
    if (data.enabled !== undefined) {
      this.enabled = data.enabled;
    }
  }

  public update(dt: number): void {
    if (!this.enabled) return;

    // Lazy initialization: buscar FPSCameraController
    if (!this.initialized) {
      this.fpsCamera = this.getOwner().getComponent(
        'fps_camera_controller',
      ) as FPSCameraControllerComponent;

      if (!this.fpsCamera) {
        console.warn('CameraCrouchComponent: No FPSCameraController found on owner');
        return;
      }

      // Capturar altura base del FPSCamera
      const eyeOffset = this.fpsCamera.getEyeOffset();
      if (eyeOffset) {
        this.baseEyeHeight = eyeOffset[1];
        this.currentEyeHeight = this.baseEyeHeight;
      }

      this.initialized = true;
    }

    if (!this.fpsCamera) return;

    // Obtener estado del character controller
    const charCtrl = this.getOwner().getComponent(
      'parkour_controller',
    ) as CharacterControllerComponent | null;
    if (!charCtrl) return;

    const isRolling = charCtrl.getIsRolling();

    // Si está haciendo roll, calcular altura basada en función seno negada
    if (isRolling) {
      const rollTimer = charCtrl.getRollTimer();
      const rollDuration = charCtrl.getRollDuration();

      // Progreso del roll (0.0 a 1.0)
      const rollProgress = Math.min(rollTimer / rollDuration, 1.0);

      // Función seno negada: empieza en 0, baja a -1 en el medio (PI/2), vuelve a 0 al final (PI)
      // -sin(progress * PI) da valores de 0 -> -1 -> 0
      const sineValue = -Math.sin(rollProgress * Math.PI);

      // Interpolación entre altura base y altura de crouch usando el seno
      // Cuando sineValue = 0 -> baseEyeHeight
      // Cuando sineValue = -1 -> slideCrouchHeight
      const heightDifference = this.baseEyeHeight - this.slideCrouchHeight;
      this.currentEyeHeight = this.baseEyeHeight + sineValue * heightDifference;
    }
    // Si no está haciendo roll, volver suavemente a la altura base
    else {
      const heightDiff = this.baseEyeHeight - this.currentEyeHeight;
      this.currentEyeHeight += heightDiff * Math.min(1.0, dt * this.crouchSpeed);
    }

    // Actualizar eyeOffset Y del FPSCamera
    const eyeOffset = this.fpsCamera.getEyeOffset();
    if (eyeOffset) {
      eyeOffset[1] = this.currentEyeHeight;
    }
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug
  }

  public override dispose(): void {
    // Restaurar altura original si es necesario
    if (this.fpsCamera) {
      const eyeOffset = this.fpsCamera.getEyeOffset();
      if (eyeOffset) {
        eyeOffset[1] = this.baseEyeHeight;
      }
    }
  }
}
