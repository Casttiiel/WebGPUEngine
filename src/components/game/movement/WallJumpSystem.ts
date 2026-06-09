import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import type { IMovementController } from './IMovementController';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';

/**
 * WallJumpSystem — Bounce-off wall jump para LynxController.
 *
 * Detecta paredes mediante raycasts radiales alrededor del jugador.
 * Al pulsar JUMP mientras hay una pared cercana (y el jugador está en el aire),
 * aplica un rebote: refleja la velocidad horizontal sobre la normal de la pared
 * y añade el impulso de salto vertical.
 *
 * No hace wall run. Solo bounce.
 */
export class WallJumpSystem {
  // ── Detección ────────────────────────────────────────────────────────────
  private readonly detectWallDistance: number = 1.25;

  // ── Bounce ───────────────────────────────────────────────────────────────
  /** Factor de boost horizontal al rebotar (>1 = gana velocidad al salir). */
  private readonly bounceSpeedMultiplier: number = 1.1;
  /** Desactiva el input brevemente para que el jugador salga de la pared. */
  private readonly inputDisableTime: number = 0.15;

  // ── Coyote time ──────────────────────────────────────────────────────────
  private readonly coyoteTime: number = 0.3;
  private coyoteTimer: number = 0;
  private lastWallNormal: vec3 = vec3.create();

  /** Ventana desde el primer contacto con la pared durante la que se puede hacer wall jump. */
  private readonly wallContactWindow: number = 0.25;
  /** Timer que cuenta desde el primer contacto. Wall jump solo si > 0. */
  private wallContactTimer: number = 0;

  // ── Estado ───────────────────────────────────────────────────────────────
  private wallNormal: vec3 = vec3.create();
  private isNearWall: boolean = false;
  /** Velocidad horizontal capturada en el primer frame de contacto con la pared,
   * antes de que el KCC recorte el componente que entra en ella. */
  private incomingVelocity: vec3 = vec3.create();
  private lastIncomingVelocity: vec3 = vec3.create();

  constructor(private controller: IMovementController) {}

  /**
   * Detecta paredes y gestiona el coyote timer.
   * Llamar cada frame antes del switch de estados.
   */
  public update(dt: number): void {
    this.detectWall();

    // Coyote timer: se decrementa mientras el jugador está en el aire
    if (!this.controller.getIsGrounded()) {
      if (this.coyoteTimer > 0) this.coyoteTimer -= dt;
    } else {
      this.coyoteTimer = 0;
    }

    // Ventana de contacto: solo cuenta mientras estamos cerca de la pared
    if (this.isNearWall && this.wallContactTimer > 0) {
      this.wallContactTimer -= dt;
    }
  }

  /**
   * Intenta ejecutar un wall jump si hay buffered JUMP y pared cerca.
   * Llamar desde el bloque IDLE del controller (estado en el aire).
   * @returns true si se ejecutó un wall jump.
   */
  public tryWallJump(): boolean {
    if (this.controller.getIsGrounded()) return false;

    // Pared activa: solo dentro de la ventana de contacto
    const wallActive = this.isNearWall && this.wallContactTimer > 0;
    // Coyote: ventana tras despegarse (usa lastIncomingVelocity guardada al despegar)
    const hasWall = wallActive || this.coyoteTimer > 0;
    if (!hasWall) return false;

    const input = Engine.getInput();
    if (!input.isActionBuffered(GameAction.JUMP)) return false;

    input.consumeBufferedAction(GameAction.JUMP);

    const normal = this.isNearWall ? this.wallNormal : this.lastWallNormal;
    console.log('------------------');
    console.log('Wall jump! Normal:', normal, 'Is nearwall:', this.isNearWall);
    const incoming = this.isNearWall ? this.incomingVelocity : this.lastIncomingVelocity;
    console.log(
      'Incoming velocity:',
      this.incomingVelocity,
      'Last incoming:',
      this.lastIncomingVelocity,
    );
    this.applyBounce(normal, incoming);
    return true;
  }

  // ── Privado ───────────────────────────────────────────────────────────────

  private detectWall(): void {
    const camera = this.controller.getCamera();
    if (!camera) return;

    const origin = this.controller.getCollider().getRigidBody().translation();
    const physics = Engine.getPhysics();

    // Cuatro raycasts: izquierda, derecha, adelante, atrás (horizontal puro)
    const cam = camera.getCamera();
    const front = cam.getFront();
    front[1] = 0;
    vec3.normalize(front, front);

    const right = vec3.fromValues(-front[2], 0, front[0]);

    const dirs: vec3[] = [
      vec3.clone(front),
      vec3.negate(vec3.create(), front),
      vec3.clone(right),
      vec3.negate(vec3.create(), right),
    ];

    this.isNearWall = false;

    for (const dir of dirs) {
      const ray = new RAPIER.Ray(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: dir[0], y: dir[1], z: dir[2] },
      );

      const hit = physics
        .getWorld()
        .castRayAndGetNormal(
          ray,
          this.detectWallDistance,
          true,
          QueryFilterFlags.EXCLUDE_SENSORS,
          undefined,
          this.controller.getCollider().getCollider(),
        );

      if (hit && hit.collider.parent()?.bodyType() === RAPIER.RigidBodyType.Fixed) {
        const n = vec3.fromValues(hit.normal.x, hit.normal.y, hit.normal.z);
        // Solo paredes (normal mayormente horizontal)
        if (Math.abs(n[1]) < 0.5) {
          if (!this.isNearWall) {
            // Primer frame de contacto: capturar velocidad y arrancar ventana
            vec3.copy(this.incomingVelocity, this.controller.getHorizontalVelocity());
            this.wallContactTimer = this.wallContactWindow;
          }
          this.isNearWall = true;
          vec3.copy(this.wallNormal, n);

          // Arrancar coyote timer al perder contacto con la pared
          vec3.copy(this.lastWallNormal, n);
          vec3.copy(this.lastIncomingVelocity, this.incomingVelocity);
          this.coyoteTimer = this.coyoteTime;
          break;
        }
      }
    }

    if (!this.isNearWall) {
      // Ya no hay pared: limpiar la velocidad de entrada (la coyote preserva lastIncomingVelocity)
      vec3.zero(this.incomingVelocity);
    }
  }

  private applyBounce(wallNormal: vec3, incoming: vec3): void {
    const incomingSpeed = vec3.length(incoming);

    // Si la velocidad de entrada es casi cero (p.ej. jugador parado contra la pared),
    // usar la normal de la pared directamente como dirección de salida.
    let reflected: vec3;
    if (incomingSpeed < 0.5) {
      reflected = vec3.clone(wallNormal);
    } else {
      // reflect(v, n) = v - 2 * dot(v, n) * n
      const dot = vec3.dot(incoming, wallNormal);
      reflected = vec3.scaleAndAdd(vec3.create(), incoming, wallNormal, -2 * dot);
    }

    // Aplicar boost de velocidad al salir
    const outSpeed = Math.max(incomingSpeed, 11.0) * this.bounceSpeedMultiplier;
    vec3.normalize(reflected, reflected);
    vec3.scale(reflected, reflected, outSpeed);

    this.controller.setHorizontalVelocity(reflected);
    this.controller.applyJumpFromSystem();
    this.controller.setInputDisableTimer(this.inputDisableTime);

    this.isNearWall = false;
    this.coyoteTimer = 0;
  }

  public getIsNearWall(): boolean {
    return this.isNearWall;
  }

  public getWallNormal(): vec3 {
    return this.wallNormal;
  }
}
