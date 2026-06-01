import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER from '@dimforge/rapier3d';

/**
 * DashSystem — Dash momentum-based hacia un punto detectado por raycast.
 *
 * Al iniciar: calcula la dirección al hit point y lanza el dash.
 * Cada frame: aplica una fuerza horizontal que decae con easeOut durante dashDuration.
 * Fin: por tiempo (timer >= dashDuration).
 * Recarga: 1 airDashCharge, se restaura al aterrizar.
 */
export class DashSystem {
  // ── Detección ────────────────────────────────────────────────────────────
  private readonly dashDetectionDistance: number = 28.0;

  // ── Fuerza / curva ───────────────────────────────────────────────────────
  /** Magnitud del impulso inicial (m/s). */
  private readonly dashForce: number = 25.0;
  /** Ventana mínima que el estado DASHING bloquea otras acciones (segundos). */
  private readonly dashDuration: number = 0.3;

  // ── Estado ───────────────────────────────────────────────────────────────
  private dashTimer: number = 0;
  private dashDirection: vec3 = vec3.create();

  // ── Cargas en aire ───────────────────────────────────────────────────────
  private airDashCharges: number = 1;
  private readonly maxAirDashCharges: number = 1;

  constructor(
    private controller: IMovementController,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  /** Detecta input y arranca el dash. Llamar solo en estado IDLE. */
  public update(): void {
    const input = Engine.getInput();

    if (
      this.controller.getIsDashing() ||
      this.controller.getIsMantling() ||
      this.controller.getIsSwinging() ||
      this.airDashCharges <= 0
    ) {
      return;
    }

    if (input.isActionJustPressed(GameAction.DASH)) {
      const dashPoint = this.detectDashPoint();
      if (dashPoint) {
        this.startDash(dashPoint);
      }
    }
  }

  /** Gestiona el timer del dash y transiciona a IDLE al expirar. Llamar en el case DASHING del controller. */
  public updateDash(dt: number): void {
    this.dashTimer += dt;
    if (this.dashTimer >= this.dashDuration) {
      this.controller.setIsDashing(false);
    }
  }

  private detectDashPoint(): vec3 | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();
    const forward = camera.getCamera().getFront();

    // Offset el origen para evitar toi=0 cuando el ray arranca dentro de geometría sólida
    const originOffset = 0.8;
    const ray = new RAPIER.Ray(
      {
        x: playerPos.x + forward[0] * originOffset,
        y: playerPos.y + forward[1] * originOffset,
        z: playerPos.z + forward[2] * originOffset,
      },
      { x: forward[0], y: forward[1], z: forward[2] },
    );

    const hit = physics
      .getWorld()
      .castRay(ray, this.dashDetectionDistance, true, undefined, undefined, collider.getCollider());

    if (!hit) return null;

    // hit point = origen_offset + forward * toi
    const origin = vec3.fromValues(
      playerPos.x + forward[0] * originOffset,
      playerPos.y + forward[1] * originOffset,
      playerPos.z + forward[2] * originOffset,
    );
    const dir = vec3.fromValues(forward[0], forward[1], forward[2]);
    return vec3.scaleAndAdd(vec3.create(), origin, dir, hit.timeOfImpact);
  }

  private startDash(targetPoint: vec3): void {
    const collider = this.controller.getCollider();
    const p = collider.getRigidBody().translation();
    const playerPos = vec3.fromValues(p.x, p.y, p.z);

    const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), targetPoint, playerPos));
    vec3.copy(this.dashDirection, dir);

    // Redirigir el momentum horizontal actual a la dirección del dash,
    // luego sumar el impulso del dash encima.
    const currentHVel = this.controller.getHorizontalVelocity();
    const currentSpeed = vec3.length(currentHVel);
    const redirected = vec3.scale(vec3.create(), dir, currentSpeed);
    redirected[1] = 0;
    this.controller.setHorizontalVelocity(redirected);
    this.controller.applyImpulse(vec3.scale(vec3.create(), dir, this.dashForce));

    this.dashTimer = 0;
    this.airDashCharges--;
    this.controller.setIsDashing(true);
    this.controller.setInputDisableTimer(this.dashDuration);
  }

  public onGrounded(): void {
    this.airDashCharges = this.maxAirDashCharges;
  }

  public getAirDashCharges(): number {
    return this.airDashCharges;
  }
}
