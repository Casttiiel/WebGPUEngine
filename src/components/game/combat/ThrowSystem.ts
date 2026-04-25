import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import { BulletPoolComponent } from '../BulletPoolComponent';

/**
 * ThrowSystem — Gestiona el lanzamiento de dagas del ArcaneKnight.
 *
 * Mecánicas:
 *  - Máximo de cargas configurable (default 3).
 *  - Una carga se regenera cada `regenTime` segundos (default 5s) de forma pasiva,
 *    incluso mientras se lanzan dagas, siempre que no se esté al máximo.
 *  - Las dagas son un arma desbloqueable: hasta que no se llame a unlock(),
 *    el sistema no procesa input ni regenera cargas.
 *
 * TODO: instanciar proyectil/entidad visual al lanzar.
 */
export class ThrowSystem {
  private readonly maxCharges: number;
  private readonly regenTime: number;
  private readonly poolName: string;

  private charges: number;
  private regenTimer: number = 0;
  private unlocked: boolean = true;

  // Lazily resolved on first throw
  private pool: BulletPoolComponent | null = null;

  constructor(data: {
    daggerMaxCharges?: number;
    daggerRegenTime?: number;
    daggerPoolName?: string;
  }) {
    this.maxCharges = data.daggerMaxCharges ?? 3;
    this.regenTime = data.daggerRegenTime ?? 3.0;
    this.poolName = data.daggerPoolName ?? 'DaggerManager';
    this.charges = this.maxCharges;
  }

  // ──────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────

  public update(dt: number, camera: CameraComponent | null): void {
    if (!this.unlocked) return;

    this.tickRegen(dt);
    this.processInput(camera);
  }

  private tickRegen(dt: number): void {
    if (this.charges >= this.maxCharges) return;

    this.regenTimer -= dt;
    if (this.regenTimer <= 0) {
      this.charges = Math.min(this.charges + 1, this.maxCharges);
      // Reiniciar el timer para la siguiente carga (solo si aún falta alguna)
      if (this.charges < this.maxCharges) {
        this.regenTimer = this.regenTime;
      } else {
        this.regenTimer = 0;
      }
    }
  }

  private processInput(camera: CameraComponent | null): void {
    if (this.charges <= 0) return;

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.THROW)) return;

    this.throw(camera);
  }

  // ──────────────────────────────────────────────────────────
  // LANZAMIENTO
  // ──────────────────────────────────────────────────────────

  private throw(camera: CameraComponent | null): void {
    this.charges--;

    // Arrancar regen si es la primera carga gastada desde que estábamos llenos
    if (this.regenTimer <= 0) {
      this.regenTimer = this.regenTime;
    }

    if (!camera) return;

    // Lazy-resolve pool
    if (!this.pool) {
      const entity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
      if (!this.pool) {
        console.warn(`[ThrowSystem] No bullet_pool found on entity "${this.poolName}"`);
        return;
      }
    }

    const dagger = this.pool.acquire();
    if (!dagger) return; // all daggers already in flight

    const cam = camera.getCamera();
    const origin = cam.getPosition();
    const dir = cam.getFront();

    // Offset slightly forward so the dagger spawns in front of the camera
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.6);
    dagger.fire(muzzle, dir, this.pool.release.bind(this.pool));
  }

  // ──────────────────────────────────────────────────────────
  // UNLOCK
  // ──────────────────────────────────────────────────────────

  /** Desbloquea las dagas. A partir de aquí el sistema es funcional. */
  public unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.charges = this.maxCharges;
    this.regenTimer = 0;
  }

  public isUnlocked(): boolean {
    return this.unlocked;
  }

  // ──────────────────────────────────────────────────────────
  // CONSULTAS PÚBLICAS
  // ──────────────────────────────────────────────────────────

  public getCharges(): number {
    return this.charges;
  }

  public getMaxCharges(): number {
    return this.maxCharges;
  }

  /** Progreso de 0→1 de la recarga de la siguiente carga (0 = recién gastada, 1 = lista). */
  public getRegenProgress(): number {
    if (this.charges >= this.maxCharges) return 1;
    if (this.regenTimer <= 0) return 1;
    return 1 - this.regenTimer / this.regenTime;
  }
}
