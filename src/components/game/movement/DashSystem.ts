import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { CollisionGroups } from '../../../types/CollisionGroups.enum';

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
  /** Distancia extra que se añade al hit point cuando el objetivo es un enemigo (atravesar). */
  private readonly enemyPassThroughOffset: number = 0.3;

  // ── Fuerza / curva ───────────────────────────────────────────────────────
  /** Magnitud del impulso inicial (m/s). */
  private readonly dashForce: number = 25.0;
  /** Ventana mínima que el estado DASHING bloquea otras acciones (segundos). */
  private readonly dashDuration: number = 1.0;

  // ── Estado ───────────────────────────────────────────────────────────────
  private dashTimer: number = 0;
  private dashDirection: vec3 = vec3.create();
  private isDashingThroughEnemy: boolean = false;
  /** Referencia al collider del enemigo objetivo durante un dash de atravesar. */
  private dashTargetCollider: RAPIER.Collider | null =
    null; /** Punto objetivo del dash (para detectar cuándo el jugador lo ha atravesado). */
  private dashTargetPoint: vec3 | null = null;
  /** Safety timer máximo para dash a enemigo (evita que se quede atascado). */
  private readonly maxEnemyDashDuration: number = 1.6;
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

  /** Gestiona el fin del dash. Si es a enemigo, termina cuando el jugador lo atraviesa (por posición). */
  public updateDash(dt: number): void {
    this.dashTimer += dt;

    if (this.isDashingThroughEnemy && this.dashTargetPoint) {
      // Fin por posición: el jugador ha pasado el punto objetivo
      const p = this.controller.getCollider().getRigidBody().translation();
      const playerPos = vec3.fromValues(p.x, p.y, p.z);
      const toTarget = vec3.sub(vec3.create(), this.dashTargetPoint, playerPos);
      const hasPassed = vec3.dot(toTarget, this.dashDirection) <= 0;

      // Safety fallback por si el jugador no llega (colisión inesperada, etc.)
      const safetyExpired = this.dashTimer >= this.maxEnemyDashDuration;

      if (hasPassed || safetyExpired) {
        this.endDash();
      }
    } else if (this.dashTimer >= this.dashDuration) {
      this.endDash();
    }
  }

  private endDash(): void {
    this.isDashingThroughEnemy = false;
    this.dashTargetCollider = null;
    this.dashTargetPoint = null;
    this.controller.setIsDashing(false);
  }

  private detectDashPoint(): vec3 | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();
    const forward = camera.getCamera().getFront();

    // Offset el origen para evitar toi=0 cuando el ray arranca dentro de geometría sólida
    const ray = new RAPIER.Ray(
      {
        x: playerPos.x,
        y: playerPos.y,
        z: playerPos.z,
      },
      { x: forward[0], y: forward[1], z: forward[2] },
    );

    const hit = physics
      .getWorld()
      .castRay(
        ray,
        this.dashDetectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!hit) return null;

    // hit point = origen_offset + forward * toi
    const origin = vec3.fromValues(playerPos.x, playerPos.y, playerPos.z);
    const dir = vec3.fromValues(forward[0], forward[1], forward[2]);
    const hitPoint = vec3.scaleAndAdd(vec3.create(), origin, dir, hit.timeOfImpact);

    // Si el hit es un enemigo, extender el punto para atravesarlo
    const hitMembership = hit.collider.collisionGroups() >>> 16;
    this.isDashingThroughEnemy = (hitMembership & CollisionGroups.ENEMY) !== 0;
    if (this.isDashingThroughEnemy) {
      this.dashTargetCollider = hit.collider;
      vec3.scaleAndAdd(hitPoint, hitPoint, dir, this.enemyPassThroughOffset);
    } else {
      this.dashTargetCollider = null;
    }

    return hitPoint;
  }

  private startDash(targetPoint: vec3): void {
    const collider = this.controller.getCollider();
    const p = collider.getRigidBody().translation();
    const playerPos = vec3.fromValues(p.x, p.y, p.z);

    const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), targetPoint, playerPos));
    vec3.copy(this.dashDirection, dir);

    // Suprimir colisión ANTES de aplicar velocidad — ahora via filterPredicate en KCC,
    // no necesitamos modificar collision groups directamente.

    // Redirigir el momentum horizontal actual a la dirección del dash,
    // luego sumar el impulso del dash encima.
    const currentHVel = this.controller.getHorizontalVelocity();
    const currentSpeed = vec3.length(currentHVel);
    const redirected = vec3.scale(vec3.create(), dir, currentSpeed);
    redirected[1] = 0;
    this.controller.setHorizontalVelocity(redirected);
    this.controller.applyImpulse(vec3.scale(vec3.create(), dir, this.dashForce));

    console.log(`[DashSystem] startDash — isDashingThroughEnemy: ${this.isDashingThroughEnemy}`);

    this.dashTargetPoint = vec3.clone(targetPoint);
    this.dashTimer = 0;
    this.airDashCharges--;
    this.controller.setIsDashing(true);
    const disableDuration = this.isDashingThroughEnemy
      ? this.maxEnemyDashDuration
      : this.dashDuration;
    this.controller.setInputDisableTimer(disableDuration);
  }

  /**
   * Devuelve el collider del enemigo objetivo si estamos haciendo dash a través de él,
   * para que el KCC lo excluya vía filterPredicate.
   */
  public getDashTargetCollider(): RAPIER.Collider | null {
    return this.isDashingThroughEnemy ? this.dashTargetCollider : null;
  }

  public onGrounded(): void {
    this.airDashCharges = this.maxAirDashCharges;
  }

  public getAirDashCharges(): number {
    return this.airDashCharges;
  }
}
