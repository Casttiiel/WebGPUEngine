import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import { MouseButton } from '../../../types/MouseButton.enum';
import { Msg } from '../../../core/ecs/Msg';
import { HealthComponent } from '../HealthComponent';
import type { CameraComponent } from '../../render/CameraComponent';
import type { MarkSystem } from './MarkSystem';

export interface MarkerShotSystemData {
  /** Maximum number of stored charges. Default: 3. */
  maxCharges?: number;
  /** Seconds per charge regeneration. Default: 2.5. */
  rechargeTime?: number;
  /** Damage dealt per shot. Default: 5 (minimal). */
  shotDamage?: number;
  /** How long a mark lasts in seconds. Default: 15. */
  markDuration?: number;
  /** Maximum hitscan range in units. Default: 80. */
  maxRange?: number;
}

/**
 * MarkerShotSystem — Hitscan shots that mark hit enemies.
 *
 * Mechanics:
 *  - Up to `maxCharges` charges available at once.
 *  - Charges regenerate at 1 per `rechargeTime` seconds.
 *  - On LMB press (with charges available): fires an instant hitscan ray from
 *    the camera. Any enemy (entity with HealthComponent) takes `shotDamage` and
 *    is registered in MarkSystem for `markDuration` seconds.
 */
export class MarkerShotSystem {
  private readonly maxCharges: number;
  private readonly rechargeTime: number;
  private readonly shotDamage: number;
  private readonly markDuration: number;
  private readonly maxRange: number;

  private charges: number;
  private rechargeTimer: number = 0;

  constructor(data?: MarkerShotSystemData) {
    this.maxCharges = data?.maxCharges ?? 3;
    this.rechargeTime = data?.rechargeTime ?? 2.5;
    this.shotDamage = data?.shotDamage ?? 5;
    this.markDuration = data?.markDuration ?? 15;
    this.maxRange = data?.maxRange ?? 80;
    this.charges = this.maxCharges;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  public update(dt: number, camera: CameraComponent | null, markSystem: MarkSystem): void {
    this.tickRecharge(dt);

    if (!camera) return;

    const input = Engine.getInput();
    if (input.isMouseButtonJustPressed(MouseButton.LEFT) && this.charges > 0) {
      this.charges--;
      this.fireShot(camera, markSystem);
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

  private fireShot(camera: CameraComponent, markSystem: MarkSystem): void {
    const cam = camera.getCamera();
    const front = cam.getFront() as vec3;
    const eye = cam.getPosition() as vec3;

    const physics = Engine.getPhysics();
    const world = physics.getWorld();

    const ray = new RAPIER.Ray(
      { x: eye[0], y: eye[1], z: eye[2] },
      { x: front[0], y: front[1], z: front[2] },
    );

    const hit = world.castRay(ray, this.maxRange, true, QueryFilterFlags.EXCLUDE_SENSORS);

    if (!hit) return;

    const entityId = physics.getEntityIdFromCollider(hit.collider.handle);
    if (entityId === undefined) return;

    const entity = Engine.getEntities().getEntityById(entityId);
    if (!entity) return;

    const health = entity.getComponent('health') as HealthComponent | null;
    if (!health) return;

    // Minimal damage
    entity.sendMsg(
      Msg.damage({ amount: this.shotDamage, instigator: null, sourceTag: 'lynx_mark_shot' }),
    );

    // Mark the enemy
    markSystem.markEnemy(entityId, this.markDuration);
  }
}
