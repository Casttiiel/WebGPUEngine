import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';
import { GameAction } from '../../types/GameAction.enum';

export interface HeadTiltComponentData {
  maxTiltAmplitude?: number; // Inclinacion maxima (radianes)
  tiltSpeed?: number; // Velocidad de inclinación (radianes por segundo)
  enabled?: boolean; // Activar/desactivar head tilt
}

/**
 * HeadTiltComponent - Camera Head Tilting Effect
 *
 * Sistema de head tilt para cámaras FPS:
 * - Se activa solo cuando el personaje se mueve hacia los lados
 * - Offset aplicado en coordenadas locales de la cámara
 *
 * Requiere:
 * - CharacterControllerComponent en el owner (para obtener velocidad)
 */
export class HeadTiltComponent extends Component {
  // Configuración
  private maxTiltAmplitude: number = 0.5; // Inclinación máxima (radianes)
  private tiltSpeed: number = 1.0; // Velocidad de inclinación (radianes por segundo)
  private enabled: boolean = true; // Activar head tilt

  // Estado
  private headTiltOffset: number = 0.0; // Offset actual del tilt

  constructor() {
    super();
  }

  public async load(data: HeadTiltComponentData): Promise<void> {
    if (data.maxTiltAmplitude !== undefined) {
      this.maxTiltAmplitude = data.maxTiltAmplitude;
    }

    if (data.tiltSpeed !== undefined) {
      this.tiltSpeed = data.tiltSpeed;
    }

    if (data.enabled !== undefined) {
      this.enabled = data.enabled;
    }
  }

  public update(dt: number): void {
    if (!this.enabled) {
      this.headTiltOffset = 0.0;
      return;
    }

    // Obtener estado del character controller
    const characterController = this.getOwner().getComponent('character_controller');
    if (!characterController) {
      this.headTiltOffset = 0.0;
      return;
    }

    const isSliding = (characterController as CharacterControllerComponent).getIsSliding() ?? false;
    const leftKeyPressed = Engine.getInput().isActionPressed(GameAction.MOVE_LEFT);
    const rightKeyPressed = Engine.getInput().isActionPressed(GameAction.MOVE_RIGHT);

    // Solo aplicar head tilt si:
    // 1. Está en el suelo (no saltando)
    // 2. No está sliding
    if (isSliding || (leftKeyPressed && rightKeyPressed) || (!leftKeyPressed && !rightKeyPressed)) {
      // Fade out suave cuando se detiene, salta o hace slide
      this.headTiltOffset *= Math.max(0, 1.0 - dt * 10.0);
      return;
    }

    let sign = leftKeyPressed ? -1 : 1;

    this.headTiltOffset = Math.min(
      this.maxTiltAmplitude,
      this.headTiltOffset + this.tiltSpeed * dt * sign,
    );

    this.headTiltOffset = Math.max(-this.maxTiltAmplitude, this.headTiltOffset);
  }

  /**
   * Obtiene el offset actual del head bob en coordenadas locales de la cámara
   * @returns Vector3 con el offset (x = horizontal, y = vertical, z = 0)
   */
  public getTiltOffset(): number {
    return this.headTiltOffset;
  }

  /**
   * Obtiene el offset del head bob transformado a coordenadas del mundo
   * usando los vectores de dirección de la cámara
   * @param right Vector derecho de la cámara
   * @param up Vector arriba de la cámara
   * @returns Vector3 con el offset en world space
   */
  public getHeadTilt(right: vec3, up: vec3): vec3 {
    const bobOffsetWorld = vec3.create();
    vec3.scaleAndAdd(bobOffsetWorld, bobOffsetWorld, right, this.headTiltOffset); // Horizontal
    vec3.scaleAndAdd(bobOffsetWorld, bobOffsetWorld, up, 0); // Vertical
    return bobOffsetWorld;
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug del head bob
  }

  public dispose(): void {
    // Limpieza si es necesario
  }
}
