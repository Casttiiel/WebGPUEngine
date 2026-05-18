import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { MouseButton } from '../../../types/MouseButton.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import { BulletPoolComponent } from '../BulletPoolComponent';
import type { BloodComponent } from '../BloodComponent';
import type { HealthComponent } from '../HealthComponent';

/**
 * DaggerBurstSystem — Lanza una ráfaga de 3 dagas al pulsar click izquierdo.
 *
 * Mecánica:
 *  - Al pulsar LMB (si el cooldown ha expirado) se encolan 3 disparos.
 *  - Cada disparo se separa del anterior `burstInterval` segundos (~80ms).
 *  - Tras la ráfaga completa arranca un cooldown entre ráfagas.
 *
 * Uso:
 *   const burst = new DaggerBurstSystem({ poolName: 'DaggerManager' });
 *   // en update(dt): burst.update(dt, this.camera);
 */
export class DaggerBurstSystem {
  private readonly burstCount: number;
  private readonly burstInterval: number; // seconds between shots within a burst
  private readonly cooldown: number; // seconds between bursts
  private readonly poolName: string;
  private readonly bloodCostPerShot: number;
  private readonly getBlood: (() => BloodComponent | null) | null;
  private readonly getHealth: (() => HealthComponent | null) | null;
  /** Returns a multiplier [0.5, 1.0] applied to the burst cooldown. */
  private readonly getCooldownMultiplier: (() => number) | null;
  /** Called each time a single dagger is fired (for bestiality tracking). */
  private readonly onShotFired: (() => void) | null;

  private cooldownTimer: number = 0;
  private pendingShots: number = 0;
  private burstTimer: number = 0;

  // Lazily resolved on first fire
  private pool: BulletPoolComponent | null = null;

  constructor(data?: {
    burstCount?: number;
    burstInterval?: number;
    cooldown?: number;
    poolName?: string;
    bloodCostPerShot?: number;
    getBlood?: () => BloodComponent | null;
    getHealth?: () => HealthComponent | null;
    /** Optional callback returning a cooldown multiplier (e.g. from BestialitySystem). */
    getCooldownMultiplier?: () => number;
    /** Optional callback fired each time a single shot is launched. */
    onShotFired?: () => void;
  }) {
    this.burstCount = data?.burstCount ?? 3;
    this.burstInterval = data?.burstInterval ?? 0.08;
    this.cooldown = data?.cooldown ?? 0.6;
    this.poolName = data?.poolName ?? 'DaggerManager';
    this.bloodCostPerShot = data?.bloodCostPerShot ?? 0;
    this.getBlood = data?.getBlood ?? null;
    this.getHealth = data?.getHealth ?? null;
    this.getCooldownMultiplier = data?.getCooldownMultiplier ?? null;
    this.onShotFired = data?.onShotFired ?? null;
  }

  // ──────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────

  public update(dt: number, camera: CameraComponent | null): void {
    // Tick global cooldown
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }

    // Trigger a new burst on LMB press (only if cooldown has expired and no burst in progress)
    const input = Engine.getInput();
    if (
      input.isMouseButtonJustPressed(MouseButton.LEFT) &&
      this.cooldownTimer <= 0 &&
      this.pendingShots === 0
    ) {
      // Block the burst if the player is dead
      if (this.getHealth?.()?.isDead()) return;

      this.pendingShots = this.burstCount;
      this.burstTimer = 0; // fire first shot on the very next tick
      this.cooldownTimer = this.cooldown * (this.getCooldownMultiplier?.() ?? 1.0);
    }

    // Drain the pending burst queue
    if (this.pendingShots > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.fireOne(camera);
        this.pendingShots--;
        // Schedule next shot only if more remain
        if (this.pendingShots > 0) {
          this.burstTimer = this.burstInterval;
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // INTERNALS
  // ──────────────────────────────────────────────────────────

  private fireOne(camera: CameraComponent | null): void {
    if (!camera) return;

    // Spend blood; if insufficient, drain the remainder and charge health for the deficit
    if (this.bloodCostPerShot > 0) {
      const blood = this.getBlood?.();
      if (blood) {
        const available = blood.getBlood();
        blood.spendClamped(this.bloodCostPerShot);
        const deficit = this.bloodCostPerShot - available;
        if (deficit > 0) {
          this.getHealth?.()?.takeDamage(deficit);
        }
      }
    }

    if (!this.pool) {
      const entity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
      if (!this.pool) {
        console.warn(`[DaggerBurstSystem] No bullet_pool found on entity "${this.poolName}"`);
        return;
      }
    }

    const dagger = this.pool.acquire();
    if (!dagger) return; // all daggers already in flight

    const cam = camera.getCamera();
    const origin = cam.getPosition();
    const dir = cam.getFront();

    // Spawn dagger slightly in front of the camera so it starts outside the capsule
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.6);
    dagger.fire(muzzle, dir, this.pool.release.bind(this.pool));
    this.onShotFired?.();
  }
}
