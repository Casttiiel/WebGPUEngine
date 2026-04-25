import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';

export interface GrappleSystemData {
  /** Speed at which the player is pulled toward the grapple point (m/s). Default 28. */
  grappleSpeed?: number;
  /** Distance threshold to the target at which the grapple ends (metres). Default 1.2. */
  grappleArrivalDistance?: number;
  /** Maximum time (seconds) before the grapple is cancelled. Default 1.5. */
  grappleMaxDuration?: number;
}

/**
 * GrappleSystem — Tira al jugador hacia un punto de grapple cuando una daga lo engancha.
 *
 * Uso:
 *  1. Llama startGrapple(point) cuando la daga impacta un GrappleHookComponent.
 *  2. Llama getGrappleVelocity() desde ArcaneKnightControllerComponent mientras
 *     movementState === GRAPPLING para obtener el vector de movimiento de ese frame.
 *  3. El sistema se auto-finaliza al llegar o al superar maxDuration.
 */
export class GrappleSystem {
  private readonly speed: number;
  private readonly arrivalDistance: number;
  private readonly maxDuration: number;

  private targetPoint: vec3 = vec3.create();
  private timer: number = 0;

  constructor(
    private readonly controller: IMovementController,
    data: GrappleSystemData = {},
  ) {
    this.speed = data.grappleSpeed ?? 28;
    this.arrivalDistance = data.grappleArrivalDistance ?? 1.2;
    this.maxDuration = data.grappleMaxDuration ?? 1.5;
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /** Inicia el grapple hacia un punto del mundo. */
  public startGrapple(point: vec3): void {
    vec3.copy(this.targetPoint, point);
    this.timer = this.maxDuration;
    this.controller.setIsGrappling(true);
    // Cancelar vertical para un pull más limpio
    this.controller.setVerticalVelocity(0);
  }

  /**
   * Debe llamarse cada frame mientras movementState === GRAPPLING.
   * Retorna true si el grapple sigue activo, false si debe terminar.
   */
  public update(dt: number): boolean {
    if (!this.controller.getIsGrappling()) return false;

    this.timer -= dt;
    if (this.timer <= 0) {
      this.endGrapple();
      return false;
    }

    // Posición actual del jugador desde el collider
    const transform = this.controller.getCollider().getOwner().getComponent('transform');
    if (!transform) {
      this.endGrapple();
      return false;
    }

    const playerPos = (transform as import('../../core/TransformComponent').TransformComponent)
      .getTransform()
      .getWorldPosition();

    const toTarget = vec3.subtract(vec3.create(), this.targetPoint, playerPos);
    const dist = vec3.length(toTarget);

    if (dist <= this.arrivalDistance) {
      this.endGrapple();
      return false;
    }

    // Calcular velocidad de pull
    const dir = vec3.normalize(vec3.create(), toTarget);
    const vel = vec3.scale(vec3.create(), dir, this.speed);

    this.controller.setHorizontalVelocity(vec3.fromValues(vel[0], 0, vel[2]));
    this.controller.setVerticalVelocity(vel[1]);

    return true;
  }

  /** Velocidad horizontal+vertical actual hacia el target (para pasarla a applyMovement). */
  public getGrappleVelocity(): vec3 {
    const transform = this.controller.getCollider().getOwner().getComponent('transform');
    if (!transform) return vec3.create();

    const playerPos = (transform as import('../../core/TransformComponent').TransformComponent)
      .getTransform()
      .getWorldPosition();

    const toTarget = vec3.subtract(vec3.create(), this.targetPoint, playerPos);
    const dist = vec3.length(toTarget);
    if (dist < 0.01) return vec3.create();

    return vec3.scale(vec3.create(), vec3.normalize(vec3.create(), toTarget), this.speed);
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  private endGrapple(): void {
    this.controller.setIsGrappling(false);
  }
}
