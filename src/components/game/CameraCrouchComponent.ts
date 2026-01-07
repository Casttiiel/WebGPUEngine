import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';
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
  private enabled: boolean = true;

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
      const eyeOffset = (this.fpsCamera as any).eyeOffset;
      if (eyeOffset) {
        this.baseEyeHeight = eyeOffset[1];
        this.currentEyeHeight = this.baseEyeHeight;
      }

      this.initialized = true;
    }

    if (!this.fpsCamera) return;

    // Obtener estado del character controller
    const characterController = this.getOwner().getComponent('character_controller');
    if (!characterController) return;

    const charCtrl = characterController as CharacterControllerComponent;
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
    const eyeOffset = (this.fpsCamera as any).eyeOffset;
    if (eyeOffset) {
      eyeOffset[1] = this.currentEyeHeight;
    }
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'game';
    const subfolderKey = 'Camera Crouch';

    const self = this;

    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Enabled
    const enabledWrapper = {
      get enabled() {
        return self.enabled;
      },
      set enabled(value) {
        self.enabled = value;
      },
    };

    addControl(enabledWrapper, 'enabled', 'Enabled');

    // Slide crouch height
    const slideCrouchHeightWrapper = {
      get slideCrouchHeight() {
        return self.slideCrouchHeight;
      },
      set slideCrouchHeight(value) {
        self.slideCrouchHeight = value;
      },
    };

    addControl(slideCrouchHeightWrapper, 'slideCrouchHeight', 'Slide Height (m)', {
      min: 0.1,
      max: 1.5,
      step: 0.05,
    });

    // Crouch speed
    const crouchSpeedWrapper = {
      get crouchSpeed() {
        return self.crouchSpeed;
      },
      set crouchSpeed(value) {
        self.crouchSpeed = value;
      },
    };

    addControl(crouchSpeedWrapper, 'crouchSpeed', 'Crouch Speed', {
      min: 1.0,
      max: 20.0,
      step: 0.5,
    });

    // Current height (read-only)
    const currentHeightWrapper = {
      get currentHeight() {
        return self.currentEyeHeight.toFixed(2);
      },
    };

    addControl(currentHeightWrapper, 'currentHeight', 'Current Height (m)', { readonly: true });

    // Base height (read-only)
    const baseHeightWrapper = {
      get baseHeight() {
        return self.baseEyeHeight.toFixed(2);
      },
    };

    addControl(baseHeightWrapper, 'baseHeight', 'Base Height (m)', { readonly: true });
  }

  public renderDebug(): void {
    // TODO: Visualización debug
  }

  public dispose(): void {
    // Restaurar altura original si es necesario
    if (this.fpsCamera) {
      const eyeOffset = (this.fpsCamera as any).eyeOffset;
      if (eyeOffset) {
        eyeOffset[1] = this.baseEyeHeight;
      }
    }
  }
}
