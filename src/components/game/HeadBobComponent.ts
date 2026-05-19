import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { BasePlayerController } from './BasePlayerController';
import { CharacterControllerComponent } from './ParkourControllerComponent';

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
  private frequency: number = 1.0; // Frecuencia en Hz (2.0 = 2 ciclos por segundo)
  private verticalAmplitude: number = 0.02; // Movimiento vertical (5cm)
  private horizontalAmplitude: number = 0.02; // Movimiento horizontal (3cm)
  private speedThreshold: number = 0.5; // Velocidad mínima para activar (m/s)
  public override enabled: boolean = true; // Activar head bob

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
    const base = this.getOwner().getComponent('player_controller') as BasePlayerController | null;
    if (!base) {
      vec3.set(this.headBobOffset, 0, 0, 0);
      return;
    }
    // Extras opcionales solo disponibles con parkour controller
    const parkour = this.getOwner().getComponent(
      'parkour_controller',
    ) as CharacterControllerComponent | null;

    const currentSpeed = base.getCurrentSpeed() || 0.0;
    const isGrounded = base.getIsGrounded();
    const isRolling = parkour?.getIsRolling() ?? false;
    const isWallRunning = parkour?.getIsWallRunning() ?? false;

    // Solo aplicar head bob si:
    // 1. Está en el suelo (no saltando)
    // 2. No está rolling
    // 3. La velocidad supera el threshold
    if ((!isGrounded && !isWallRunning) || isRolling || currentSpeed < this.speedThreshold) {
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

  private _editorFolder: any = null;

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    const self = this;
    this._editorFolder = folder.addFolder('Head Bob');
    this._editorFolder.close();

    this._editorFolder.add(this, 'enabled').name('Enabled').listen();

    const p = {
      get frequency() {
        return self.frequency;
      },
      set frequency(v: number) {
        self.frequency = v;
      },
      get verticalAmplitude() {
        return self.verticalAmplitude;
      },
      set verticalAmplitude(v: number) {
        self.verticalAmplitude = v;
      },
      get horizontalAmplitude() {
        return self.horizontalAmplitude;
      },
      set horizontalAmplitude(v: number) {
        self.horizontalAmplitude = v;
      },
      get speedThreshold() {
        return self.speedThreshold;
      },
      set speedThreshold(v: number) {
        self.speedThreshold = v;
      },
    };
    this._editorFolder.add(p, 'frequency', 0.5, 5.0, 0.1).name('Frequency (Hz)').listen();
    this._editorFolder
      .add(p, 'verticalAmplitude', 0.0, 0.2, 0.005)
      .name('Vertical Amplitude')
      .listen();
    this._editorFolder
      .add(p, 'horizontalAmplitude', 0.0, 0.2, 0.005)
      .name('Horizontal Amplitude')
      .listen();
    this._editorFolder.add(p, 'speedThreshold', 0.0, 5.0, 0.1).name('Speed Threshold').listen();
  }

  public renderDebug(): void {
    // TODO: Visualización debug del head bob
  }

  public override dispose(): void {
    // Limpieza si es necesario
  }
}
