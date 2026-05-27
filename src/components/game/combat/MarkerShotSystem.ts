import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { MouseButton } from '../../../types/MouseButton.enum';
import { Engine } from '../../../core/engine/Engine';
import type { BulletPoolComponent } from '../BulletPoolComponent';
import type { CameraComponent } from '../../render/CameraComponent';
import type { MarkSystem } from './MarkSystem';
import type { MarkerProjectileComponent } from './MarkerProjectileComponent';

export interface MarkerShotSystemData {
  /** Maximum number of stored charges. Default: 3. */
  maxCharges?: number;
  /** Seconds per charge regeneration. Default: 2.5. */
  rechargeTime?: number;
  /** Damage dealt per shot. Default: 5 (minimal). */
  shotDamage?: number;
  /** How long a mark lasts in seconds. Default: 15. */
  markDuration?: number;
}

/**
 * MarkerShotSystem — Physical projectile shots that mark hit enemies.
 *
 * Mechanics:
 *  - Up to `maxCharges` charges available at once.
 *  - Charges regenerate at 1 per `rechargeTime` seconds.
 *  - On LMB press (with charges available): acquires a MarkerProjectileComponent
 *    from the bullet pool, injects the MarkSystem context, and fires it.
 */
export class MarkerShotSystem {
  private readonly maxCharges: number;
  private readonly rechargeTime: number;
  private readonly shotDamage: number;
  private readonly markDuration: number;

  private charges: number;
  private rechargeTimer: number = 0;

  constructor(data?: MarkerShotSystemData) {
    this.maxCharges = data?.maxCharges ?? 3;
    this.rechargeTime = data?.rechargeTime ?? 2.5;
    this.shotDamage = data?.shotDamage ?? 5;
    this.markDuration = data?.markDuration ?? 15;
    this.charges = this.maxCharges;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  public update(
    dt: number,
    camera: CameraComponent | null,
    markSystem: MarkSystem,
    pool: BulletPoolComponent | null,
    shooterBody: RAPIER.RigidBody | null,
  ): void {
    this.tickRecharge(dt);

    if (!camera || !pool) return;

    const input = Engine.getInput();
    if (input.isMouseButtonJustPressed(MouseButton.LEFT) && this.charges > 0) {
      this.charges--;
      this.fireShot(camera, markSystem, pool, shooterBody);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  public getCharges(): number {
    return this.charges;
  }

  public getMaxCharges(): number {
    return this.maxCharges;
  }

  /** Fraction of progress toward the next charge [0, 1). */
  public getRechargeProgress(): number {
    return this.rechargeTimer / this.rechargeTime;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private tickRecharge(dt: number): void {
    if (this.charges >= this.maxCharges) {
      this.rechargeTimer = 0;
      return;
    }
    this.rechargeTimer += dt;
    if (this.rechargeTimer >= this.rechargeTime) {
      this.rechargeTimer -= this.rechargeTime;
      this.charges = Math.min(this.charges + 1, this.maxCharges);
    }
  }

  private fireShot(
    camera: CameraComponent,
    markSystem: MarkSystem,
    pool: BulletPoolComponent,
    shooterBody: RAPIER.RigidBody | null,
  ): void {
    const cam = camera.getCamera();
    const front = cam.getFront() as vec3;
    const eye = cam.getPosition() as vec3;

    // Offset muzzle forward so the bullet starts in front of the camera/player
    const muzzle = vec3.scaleAndAdd(vec3.create(), eye, front, 0.5);

    const bullet = pool.acquire() as MarkerProjectileComponent | null;
    if (!bullet) return; // pool exhausted

    bullet.damage = this.shotDamage;
    bullet.setMarkContext(markSystem, this.markDuration);
    bullet.fire(muzzle, front, pool.release.bind(pool), shooterBody ?? undefined);
  }
}
