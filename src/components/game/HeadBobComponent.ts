import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';

export interface HeadBobComponentData {
  frequency?: number; // Frecuencia del bobbing (Hz)
  verticalAmplitude?: number; // Amplitud vertical (metros)
  horizontalAmplitude?: number; // Amplitud horizontal (metros)
  speedThreshold?: number; // Velocidad mínima para activar head bob
  enabled?: boolean; // Activar/desactivar head bob
}

/**
 * HeadBobComponent - Camera Head Bobbing Effect
 *
 * Sistema de head bob para cámaras FPS:
 * - Se activa solo cuando el personaje se mueve
 * - Sincronizado con la velocidad de movimiento
 * - Offset aplicado en coordenadas locales de la cámara
 * - Patrón sinusoidal natural (vertical + horizontal)
 *
 * Requiere:
 * - CharacterControllerComponent en el owner (para obtener velocidad)
 */
export class HeadBobComponent extends Component {
  // Configuración
  private frequency: number = 2.0; // Frecuencia en Hz (2.0 = 2 ciclos por segundo)
  private verticalAmplitude: number = 0.05; // Movimiento vertical (5cm)
  private horizontalAmplitude: number = 0.03; // Movimiento horizontal (3cm)
  private speedThreshold: number = 0.5; // Velocidad mínima para activar (m/s)
  private enabled: boolean = true; // Activar head bob

  // Estado
  private headBobTimer: number = 0.0; // Timer para el ciclo de bobbing
  private headBobOffset: vec3 = vec3.create(); // Offset actual del bobbing

  constructor() {
    super();
  }

  public async load(data: HeadBobComponentData): Promise<void> {
    if (data.frequency !== undefined) {
      this.frequency = data.frequency;
    }
    if (data.verticalAmplitude !== undefined) {
      this.verticalAmplitude = data.verticalAmplitude;
    }
    if (data.horizontalAmplitude !== undefined) {
      this.horizontalAmplitude = data.horizontalAmplitude;
    }
    if (data.speedThreshold !== undefined) {
      this.speedThreshold = data.speedThreshold;
    }
    if (data.enabled !== undefined) {
      this.enabled = data.enabled;
    }
  }

  public update(dt: number): void {
    if (!this.enabled) {
      vec3.set(this.headBobOffset, 0, 0, 0);
      return;
    }

    // Obtener estado del character controller
    const characterController = this.getOwner().getComponent('character_controller');
    if (!characterController) {
      vec3.set(this.headBobOffset, 0, 0, 0);
      return;
    }

    const currentSpeed =
      (characterController as CharacterControllerComponent).getCurrentSpeed() || 0.0;
    const isGrounded =
      (characterController as CharacterControllerComponent).getIsGrounded() ?? false;
    const isRolling = (characterController as CharacterControllerComponent).getIsRolling() ?? false;

    // Solo aplicar head bob si:
    // 1. Está en el suelo (no saltando)
    // 2. No está rolling
    // 3. La velocidad supera el threshold
    if (!isGrounded || isRolling || currentSpeed < this.speedThreshold) {
      // Fade out suave cuando se detiene, salta o hace slide
      vec3.scale(this.headBobOffset, this.headBobOffset, Math.max(0, 1.0 - dt * 5.0));
      this.headBobTimer = 0.0;
      return;
    }

    // Incrementar timer basado en la velocidad (más rápido = bobbing más rápido)
    const speedFactor = currentSpeed / 5.0; // Normalizar a velocidad típica
    this.headBobTimer += dt * this.frequency * speedFactor;

    // Patrón correcto de head bob:
    // - Horizontal: frecuencia base (sin wave)
    // - Vertical: DOBLE frecuencia (crea el efecto de arco en lugar de diagonal)
    // Esto hace que la cámara se mueva en un patrón de arco natural
    const horizontalBob = Math.sin(this.headBobTimer * Math.PI * 2) * this.horizontalAmplitude;
    const verticalBob = Math.sin(this.headBobTimer * Math.PI * 4) * this.verticalAmplitude;

    // Aplicar el bobbing (X = horizontal, Y = vertical)
    vec3.set(this.headBobOffset, horizontalBob, verticalBob, 0);
  }

  /**
   * Obtiene el offset actual del head bob en coordenadas locales de la cámara
   * @returns Vector3 con el offset (x = horizontal, y = vertical, z = 0)
   */
  public getHeadBobOffset(): vec3 {
    return this.headBobOffset;
  }

  /**
   * Obtiene el offset del head bob transformado a coordenadas del mundo
   * usando los vectores de dirección de la cámara
   * @param right Vector derecho de la cámara
   * @param up Vector arriba de la cámara
   * @returns Vector3 con el offset en world space
   */
  public getHeadBobOffsetWorld(right: vec3, up: vec3): vec3 {
    const bobOffsetWorld = vec3.create();
    vec3.scaleAndAdd(bobOffsetWorld, bobOffsetWorld, right, this.headBobOffset[0]); // Horizontal
    vec3.scaleAndAdd(bobOffsetWorld, bobOffsetWorld, up, this.headBobOffset[1]); // Vertical
    return bobOffsetWorld;
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'game';
    const subfolderKey = 'Head Bob';

    const self = this;

    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Enable head bob
    const enabledWrapper = {
      get enabled() {
        return self.enabled;
      },
      set enabled(value) {
        self.enabled = value;
      },
    };

    addControl(enabledWrapper, 'enabled', 'Enabled');

    // Frequency
    const frequencyWrapper = {
      get frequency() {
        return self.frequency;
      },
      set frequency(value) {
        self.frequency = value;
      },
    };

    addControl(frequencyWrapper, 'frequency', 'Frequency (Hz)', {
      min: 0.5,
      max: 5.0,
      step: 0.1,
    });

    // Vertical amplitude
    const verticalWrapper = {
      get verticalAmplitude() {
        return self.verticalAmplitude;
      },
      set verticalAmplitude(value) {
        self.verticalAmplitude = value;
      },
    };

    addControl(verticalWrapper, 'verticalAmplitude', 'Vertical Amplitude', {
      min: 0.0,
      max: 0.2,
      step: 0.005,
    });

    // Horizontal amplitude
    const horizontalWrapper = {
      get horizontalAmplitude() {
        return self.horizontalAmplitude;
      },
      set horizontalAmplitude(value) {
        self.horizontalAmplitude = value;
      },
    };

    addControl(horizontalWrapper, 'horizontalAmplitude', 'Horizontal Amplitude', {
      min: 0.0,
      max: 0.2,
      step: 0.005,
    });

    // Speed threshold
    const thresholdWrapper = {
      get speedThreshold() {
        return self.speedThreshold;
      },
      set speedThreshold(value) {
        self.speedThreshold = value;
      },
    };

    addControl(thresholdWrapper, 'speedThreshold', 'Speed Threshold', {
      min: 0.0,
      max: 5.0,
      step: 0.1,
    });

    // Current timer (read-only)
    const timerWrapper = {
      get timer() {
        return self.headBobTimer.toFixed(2);
      },
    };

    addControl(timerWrapper, 'timer', 'Timer (s)', { readonly: true });
  }

  public renderDebug(): void {
    // TODO: Visualización debug del head bob
  }

  public dispose(): void {
    // Limpieza si es necesario
  }
}
