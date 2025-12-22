import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';
import { GameAction } from '../../types/GameAction.enum';

export interface HeadTiltComponentData {
  maxTiltAmplitude?: number; // Inclinacion maxima (radianes)
  tiltSpeed?: number; // Velocidad de inclinación (radianes por segundo)
  mantlingTiltAmplitude?: number; // Inclinación máxima al hacer mantling
  mantlingTiltSpeed?: number; // Velocidad de inclinación al hacer mantling
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
  private mantlingTiltAmplitude: number = 0.3; // Inclinación máxima al hacer mantling
  private mantlingTiltSpeed: number = 2.0; // Velocidad de inclinación al hacer mantling
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

    if (data.mantlingTiltAmplitude !== undefined) {
      this.mantlingTiltAmplitude = data.mantlingTiltAmplitude;
    }

    if (data.mantlingTiltSpeed !== undefined) {
      this.mantlingTiltSpeed = data.mantlingTiltSpeed;
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
    const isMantling =
      (characterController as CharacterControllerComponent).getIsMantling() ?? false;
    let leftKeyPressed = Engine.getInput().isActionPressed(GameAction.MOVE_LEFT);
    let rightKeyPressed = Engine.getInput().isActionPressed(GameAction.MOVE_RIGHT);

    // Solo aplicar head tilt si:
    // 1. Está en el suelo (no saltando)
    // 2. No está sliding
    // 3. Se está moviendo lateralmente (izquierda o derecha)
    // 4. No se presionan ambas teclas a la vez
    // 5. Hace mantling
    if (
      isSliding ||
      (leftKeyPressed && rightKeyPressed && !isMantling) ||
      (!leftKeyPressed && !rightKeyPressed && !isMantling)
    ) {
      // Fade out suave cuando se detiene, salta o hace slide
      this.headTiltOffset *= Math.max(0, 1.0 - dt * 10.0);
      return;
    }

    let amplitude = this.maxTiltAmplitude;
    let speed = this.tiltSpeed;
    if (isMantling) {
      // Si hace mantling, inclinar hacia la derecha
      rightKeyPressed = true;
      amplitude = this.mantlingTiltAmplitude;
      speed = this.mantlingTiltSpeed;
    }

    let sign = leftKeyPressed ? -1 : 1;

    this.headTiltOffset = Math.min(amplitude, this.headTiltOffset + speed * dt * sign);

    this.headTiltOffset = Math.max(-amplitude, this.headTiltOffset);
  }

  /**
   * Obtiene el offset actual del head bob en coordenadas locales de la cámara
   * @returns Vector3 con el offset (x = horizontal, y = vertical, z = 0)
   */
  public getTiltOffset(): number {
    return this.headTiltOffset;
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // TODO: Visualización debug del head bob
  }

  public dispose(): void {
    // Limpieza si es necesario
  }
}
