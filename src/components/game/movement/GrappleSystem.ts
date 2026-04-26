import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import { EaseOutInterpolator } from '../../../core/math/Interpolators';
import { TransformComponent } from '../../core/TransformComponent';

export interface GrappleSystemData {
  /** Peak speed at the midpoint of the pull (m/s). Default 30. */
  grappleSpeed?: number;
  /** Distance threshold to the target at which the grapple ends (metres). Default 1.2. */
  grappleArrivalDistance?: number;
  /** Maximum time (seconds) before the grapple is cancelled. Default 1.5. */
  grappleMaxDuration?: number;
  /** Maximum distance (metres) from the player at which a grapple hook is valid. Default 20. */
  grappleMaxDistance?: number;
}

/**
 * GrappleSystem — Tira al jugador hacia un punto de grapple.
 *
 * La velocidad sigue una curva SmoothStep basada en el progreso de distancia:
 *   - Al inicio (ratio ≈ 0) la velocidad es baja (aceleración).
 *   - A mitad del recorrido la velocidad es máxima.
 *   - Al llegar (ratio ≈ 1) la velocidad vuelve a bajar (frenado suave).
 */
export class GrappleSystem {
  private readonly speed: number;
  private readonly arrivalDistance: number;
  private readonly maxDuration: number;
  private readonly maxDistance: number;
  private readonly curve = new EaseOutInterpolator();

  private targetPoint: vec3 = vec3.create();
  private startPoint: vec3 = vec3.create();
  private startDistance: number = 0;
  private timer: number = 0;

  // Velocidad calculada el último frame, lista para que ArcaneKnight la aplique.
  private currentVelocity: vec3 = vec3.create();

  constructor(
    private readonly controller: IMovementController,
    data: GrappleSystemData = {},
  ) {
    this.speed = data.grappleSpeed ?? 30;
    this.arrivalDistance = data.grappleArrivalDistance ?? 1.2;
    this.maxDuration = data.grappleMaxDuration ?? 1.5;
    this.maxDistance = data.grappleMaxDistance ?? 15;
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /** Inicia el grapple hacia un punto del mundo. Devuelve false si el punto está fuera del rango máximo. */
  public startGrapple(point: vec3): boolean {
    const playerPos = this.getPlayerPos();
    const dist = vec3.distance(playerPos, point);

    if (dist > this.maxDistance) {
      return false;
    }

    vec3.copy(this.targetPoint, point);
    vec3.copy(this.startPoint, playerPos);
    this.startDistance = dist;
    this.timer = this.maxDuration;
    this.controller.setIsGrappling(true);
    this.controller.setVerticalVelocity(0);
    vec3.zero(this.currentVelocity);
    return true;
  }

  /**
   * Llámalo cada frame desde ArcaneKnight mientras movementState === GRAPPLING.
   * Devuelve true si el grapple sigue activo, false si terminó.
   */
  public update(dt: number): boolean {
    if (!this.controller.getIsGrappling()) return false;

    this.timer -= dt;
    if (this.timer <= 0) {
      this.endGrapple();
      return false;
    }

    const playerPos = this.getPlayerPos();
    const toTarget = vec3.subtract(vec3.create(), this.targetPoint, playerPos);
    const dist = vec3.length(toTarget);

    if (dist <= this.arrivalDistance) {
      this.endGrapple();
      return false;
    }

    // ratio 0 = acaba de empezar, ratio 1 = llegó al destino
    const distTraveled = Math.max(0, this.startDistance - dist);
    const rawRatio = this.startDistance > 0 ? distTraveled / this.startDistance : 0;

    // SmoothStep: empieza lento, pico en medio, frena al llegar
    // Usamos la curva sobre (1 - ratio) para que el frenado sea al final
    const speedScale =
      this.curve.blend(0.15, 1.0, Math.min(rawRatio * 2, 1)) *
      this.curve.blend(1.0, 0.1, Math.max((rawRatio - 0.5) * 2, 0));

    const dir = vec3.normalize(vec3.create(), toTarget);
    const scaledSpeed = this.speed * speedScale;
    vec3.scale(this.currentVelocity, dir, scaledSpeed);

    return true;
  }

  /** Velocidad calculada este frame. Pasar directamente a applyMovement. */
  public getGrappleVelocity(): vec3 {
    return this.currentVelocity;
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  private getPlayerPos(): vec3 {
    const t = this.controller
      .getCollider()
      .getOwner()
      .getComponent('transform') as TransformComponent | null;
    return t ? t.getTransform().getWorldPosition() : vec3.create();
  }

  private endGrapple(): void {
    vec3.zero(this.currentVelocity);
    this.controller.setIsGrappling(false);
  }
}
