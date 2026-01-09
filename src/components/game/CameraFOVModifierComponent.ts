import { Component } from '../../core/ecs/Component';
import { CameraComponent } from '../render/CameraComponent';
import { CharacterControllerComponent } from './CharacterControllerComponent';

export interface CameraFOVModifierComponentData {
  baseFOV?: number; // FOV base en reposo (grados)
  maxFOVIncrease?: number; // Incremento máximo de FOV (grados)
  speedThreshold?: number; // Velocidad mínima para activar (m/s)
  maxSpeed?: number; // Velocidad máxima para FOV completo (m/s)
  lerpSpeed?: number; // Velocidad de interpolación del FOV
  enabled?: boolean; // Activar/desactivar el efecto
}

/**
 * CameraFOVModifierComponent - Dynamic Field of View
 *
 * Modifica el FOV de la cámara basándose en la velocidad del personaje:
 * - Aumenta FOV cuando corres rápido (sensación de velocidad)
 * - Vuelve a FOV normal cuando te detienes
 * - Interpolación suave para transiciones naturales
 *
 * Requiere:
 * - CameraComponent en los hijos del owner
 * - CharacterControllerComponent en el owner (para obtener velocidad)
 */
export class CameraFOVModifierComponent extends Component {
  // Configuración
  private baseFOV!: number; // FOV base (grados)
  private maxFOVIncrease: number = 10.0; // Incremento máximo (grados)
  private speedThreshold: number = 1.0; // Velocidad mínima para activar (m/s)
  private maxSpeed!: number; // Velocidad para FOV máximo (m/s)
  private lerpSpeed: number = 5.0; // Velocidad de interpolación
  private enabled: boolean = true;

  // Estado
  private currentFOV!: number; // FOV actual interpolado
  private targetFOV!: number; // FOV objetivo
  private initialized: boolean = false;

  // Referencias
  private cameraComponent: CameraComponent | null = null;

  constructor() {
    super();
  }

  public async load(data: CameraFOVModifierComponentData): Promise<void> {
    if (data.baseFOV !== undefined) {
      this.baseFOV = data.baseFOV;
      this.currentFOV = this.baseFOV;
      this.targetFOV = this.baseFOV;
    }
    if (data.maxFOVIncrease !== undefined) {
      this.maxFOVIncrease = data.maxFOVIncrease;
    }
    if (data.speedThreshold !== undefined) {
      this.speedThreshold = data.speedThreshold;
    }
    if (data.maxSpeed !== undefined) {
      this.maxSpeed = data.maxSpeed;
    }
    if (data.lerpSpeed !== undefined) {
      this.lerpSpeed = data.lerpSpeed;
    }
    if (data.enabled !== undefined) {
      this.enabled = data.enabled;
    }
  }

  public update(dt: number): void {
    if (!this.enabled) return;

    // Lazy initialization: buscar CameraComponent en hijos
    if (!this.initialized) {
      const children = this.getOwner().getChildren();
      for (const child of children) {
        const cam = child.getComponent('camera') as CameraComponent;
        if (cam) {
          this.cameraComponent = cam;
          break;
        }
      }

      if (!this.cameraComponent) {
        console.warn('CameraFOVModifierComponent: No camera found in owner children');
        return;
      }

      this.initialized = true;
    }

    if (!this.cameraComponent) return;

    // Obtener velocidad del character controller
    const characterController = this.getOwner().getComponent('character_controller');
    if (!characterController) return;

    // Lazy loading: obtener baseFOV de la cámara solo la primera vez que se necesita
    if (this.baseFOV === undefined) {
      const camera = this.cameraComponent.getCamera();
      const fovRadians = camera.getFov();
      this.baseFOV = (fovRadians * 180.0) / Math.PI; // Convertir radianes a grados
      this.currentFOV = this.baseFOV;
      this.targetFOV = this.baseFOV;
    }

    // Lazy loading: obtener maxSpeed solo la primera vez que se necesita
    if (this.maxSpeed === undefined) {
      this.maxSpeed = (characterController as CharacterControllerComponent).getMaxSpeed();
    }

    const currentSpeed =
      (characterController as CharacterControllerComponent).getCurrentSpeed() || 0.0;

    // Calcular FOV objetivo basado en velocidad
    if (currentSpeed < this.speedThreshold) {
      // Velocidad baja: FOV base
      this.targetFOV = this.baseFOV;
    } else {
      // Velocidad alta: interpolar FOV basado en velocidad
      // Normalizar velocidad entre speedThreshold y maxSpeed
      const normalizedSpeed = Math.min(
        1.0,
        (currentSpeed - this.speedThreshold) / (this.maxSpeed - this.speedThreshold),
      );

      // Calcular incremento de FOV
      const fovIncrease = normalizedSpeed * this.maxFOVIncrease;
      this.targetFOV = this.baseFOV + fovIncrease;
    }

    // Interpolar suavemente hacia el FOV objetivo
    const fovDiff = this.targetFOV - this.currentFOV;
    this.currentFOV += fovDiff * Math.min(1.0, dt * this.lerpSpeed);

    // Aplicar FOV a la cámara
    const camera = this.cameraComponent.getCamera();
    camera.setFov(this.currentFOV);
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug
  }

  public dispose(): void {
    // Restaurar FOV base (convertir grados a radianes)
    if (this.cameraComponent && this.baseFOV !== undefined) {
      const camera = this.cameraComponent.getCamera();
      const fovRadians = (this.baseFOV * Math.PI) / 180.0;
      camera.setFov(fovRadians);
    }
  }
}
