import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { CollisionGroups } from '../../../types/CollisionGroups.enum';

/**
 * BlinkSystem — Teletransporte instantáneo hacia un punto detectado por raycast.
 *
 * Al iniciar: calcula la dirección al hit point y lanza el blink.
 * Cada frame: aplica una fuerza horizontal que decae con easeOut durante blinkDuration.
 * Fin: por tiempo (timer >= blinkDuration).
 * Recarga: 1 airBlinkCharge, se restaura al aterrizar.
 */
export class BlinkSystem {
  // ── Detección ────────────────────────────────────────────────────────────
  private readonly blinkDetectionDistance: number = 28.0;
  /** Distancia extra que se añade al hit point cuando el objetivo es un enemigo (atravesar). */
  private readonly enemyPassThroughOffset: number = 0.3;

  // ── Fuerza / curva ───────────────────────────────────────────────────────
  /** Magnitud del impulso inicial (m/s). */
  private readonly blinkForce: number = 25.0;
  /** Ventana mínima que el estado DASHING bloquea otras acciones (segundos). */
  private readonly blinkDuration: number = 1.0;

  // ── Estado ───────────────────────────────────────────────────────────────
  private blinkTimer: number = 0;
  private blinkDirection: vec3 = vec3.create();
  private isBlinkingThroughEnemy: boolean = false;
  /**
   * Handle del collider del enemigo objetivo.
   * Guardamos el handle (número estable) en lugar del objeto WASM temporal
   * que devuelve castRay, que se libera en el siguiente step.
   */
  private blinkTargetColliderHandle: number = -1;
  /** Safety timer máximo para blink a enemigo. */
  private readonly maxEnemyBlinkDuration: number = 0.6;
  // ── Cargas en aire ───────────────────────────────────────────────────────
  private airBlinkCharges: number = 1;
  private readonly maxAirBlinkCharges: number = 1;

  constructor(
    private controller: IMovementController,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  /** Detecta input y arranca el blink. Llamar solo en estado IDLE. */
  public update(): void {
    const input = Engine.getInput();

    if (
      this.controller.getIsDashing() ||
      this.controller.getIsMantling() ||
      this.controller.getIsSwinging() ||
      this.airBlinkCharges <= 0
    ) {
      return;
    }

    if (input.isActionJustPressed(GameAction.DASH)) {
      const blinkPoint = this.detectBlinkPoint();
      if (blinkPoint) {
        this.startBlink(blinkPoint);
      }
    }
  }

  /** Gestiona el fin del blink. Si es a enemigo, termina por tiempo de seguridad. */
  public updateBlink(dt: number): void {
    this.blinkTimer += dt;

    const duration = this.isBlinkingThroughEnemy ? this.maxEnemyBlinkDuration : this.blinkDuration;
    if (this.blinkTimer >= duration) {
      this.endBlink();
    }
  }

  private endBlink(): void {
    this.isBlinkingThroughEnemy = false;
    this.blinkTargetColliderHandle = -1;
    this.controller.setIsDashing(false);
  }

  private detectBlinkPoint(): vec3 | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();
    const forward = camera.getCamera().getFront();

    const ray = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: forward[0], y: forward[1], z: forward[2] },
    );

    const hit = physics
      .getWorld()
      .castRay(
        ray,
        this.blinkDetectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!hit) return null;

    const origin = vec3.fromValues(playerPos.x, playerPos.y, playerPos.z);
    const dir = vec3.fromValues(forward[0], forward[1], forward[2]);
    const hitPoint = vec3.scaleAndAdd(vec3.create(), origin, dir, hit.timeOfImpact);

    const hitMembership = hit.collider.collisionGroups() >>> 16;
    this.isBlinkingThroughEnemy = (hitMembership & CollisionGroups.ENEMY) !== 0;
    if (this.isBlinkingThroughEnemy) {
      this.blinkTargetColliderHandle = hit.collider.handle;
      vec3.scaleAndAdd(hitPoint, hitPoint, dir, this.enemyPassThroughOffset);
    } else {
      this.blinkTargetColliderHandle = -1;
    }

    return hitPoint;
  }

  private startBlink(targetPoint: vec3): void {
    const collider = this.controller.getCollider();
    const p = collider.getRigidBody().translation();
    const playerPos = vec3.fromValues(p.x, p.y, p.z);

    const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), targetPoint, playerPos));
    vec3.copy(this.blinkDirection, dir);

    let liveCollider: RAPIER.Collider | null = null;
    if (this.isBlinkingThroughEnemy && this.blinkTargetColliderHandle !== -1) {
      liveCollider = Engine.getPhysics().getWorld().getCollider(this.blinkTargetColliderHandle);
      console.log(
        `[BlinkSystem] startBlink — enemy handle=${this.blinkTargetColliderHandle}, collider=${liveCollider ? 'OK' : 'NULL'}`,
      );
    }

    const currentHVel = this.controller.getHorizontalVelocity();
    const currentSpeed = vec3.length(currentHVel);
    const redirected = vec3.scale(vec3.create(), dir, currentSpeed);
    redirected[1] = 0;
    this.controller.setHorizontalVelocity(redirected);
    this.controller.applyImpulse(vec3.scale(vec3.create(), dir, this.blinkForce));

    this.blinkTimer = 0;
    this.airBlinkCharges--;
    this.controller.setIsDashing(true);
    const disableDuration = this.isBlinkingThroughEnemy
      ? this.maxEnemyBlinkDuration
      : this.blinkDuration;
    this.controller.setInputDisableTimer(disableDuration);
  }

  /**
   * Predicate para excluir colisiones con ENEMY durante el blink-through.
   */
  public getBlinkPredicate(): ((c: RAPIER.Collider) => boolean) | null {
    if (!this.isBlinkingThroughEnemy) return null;
    return (c: RAPIER.Collider) => {
      const membership = c.collisionGroups() >>> 16;
      return (membership & CollisionGroups.ENEMY) === 0;
    };
  }

  public onGrounded(): void {
    this.airBlinkCharges = this.maxAirBlinkCharges;
  }

  public getAirBlinkCharges(): number {
    return this.airBlinkCharges;
  }
}
