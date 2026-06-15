import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { IMovementController } from './IMovementController';

/**
 * HoverSystem — Levitar en el aire manteniendo el botón de salto.
 *
 * Mantener JUMP en el aire reduce la gravedad al hoverGravityScale (5% por defecto)
 * durante un máximo de hoverMaxDuration segundos.
 * El timer se resetea al aterrizar.
 */
export class HoverSystem {
  private hoverTimer: number = 0.0;
  private readonly hoverMaxDuration: number;
  private readonly hoverGravityScale: number;

  constructor(
    private readonly controller: IMovementController,
    hoverMaxDuration: number = 2.0,
    hoverGravityScale: number = 0.05,
  ) {
    this.hoverMaxDuration = hoverMaxDuration;
    this.hoverGravityScale = hoverGravityScale;
  }

  /**
   * Llamar cada frame desde el estado IDLE, antes de integrate().
   * Actualiza gravityScale en el controller según el input de salto.
   */
  public update(dt: number): void {
    const inAir = !this.controller.getIsGrounded();

    if (!inAir) {
      this.hoverTimer = 0;
      this.controller.setGravityScale(1.0);
      return;
    }

    const jumpHeld = Engine.getInput().isActionPressed(GameAction.JUMP);

    if (jumpHeld && this.hoverTimer < this.hoverMaxDuration) {
      this.hoverTimer += dt;
      this.controller.setGravityScale(this.hoverGravityScale);
    } else {
      this.controller.setGravityScale(1.0);
    }
  }

  /** Fuerza el reset del timer (p.ej. al cambiar de estado). */
  public reset(): void {
    this.hoverTimer = 0;
    this.controller.setGravityScale(1.0);
  }

  public getRemainingTime(): number {
    return Math.max(0, this.hoverMaxDuration - this.hoverTimer);
  }
}
