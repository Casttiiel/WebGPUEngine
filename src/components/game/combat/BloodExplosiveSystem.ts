import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { CameraComponent } from '../../render/CameraComponent';
import type { BloodComponent } from '../BloodComponent';
import { BulletPoolComponent } from '../BulletPoolComponent';
import { BloodExplosiveProjectileComponent } from './BloodExplosiveProjectileComponent';

/**
 * BloodExplosiveSystem — Right-click ability: launch a blood explosive that
 * detonates on impact, dealing instant burst AoE damage to all nearby enemies.
 *
 * Ideal for groups of clustered enemies. Triggered by GameAction.BLOOD_EXPLOSIVE
 * (mapped to RMB in DEFAULT_CONTROL_MAPPING).
 *
 * Requires a scene entity named 'BloodExplosiveManager' with a BulletPoolComponent
 * loaded with BloodExplosiveProjectileComponent prefabs.
 */
export class BloodExplosiveSystem {
  private readonly bloodCost: number;
  private readonly cooldown: number;
  private readonly poolName: string;
  private readonly explosionRadius: number;
  private readonly explosionDamage: number;
  private readonly getBlood: (() => BloodComponent | null) | null;

  private cooldownTimer: number = 0;
  private pool: BulletPoolComponent | null = null;

  constructor(data?: {
    bloodCost?: number;
    cooldown?: number;
    poolName?: string;
    explosionRadius?: number;
    explosionDamage?: number;
    getBlood?: () => BloodComponent | null;
  }) {
    this.bloodCost = data?.bloodCost ?? 20;
    this.cooldown = data?.cooldown ?? 2.0;
    this.poolName = data?.poolName ?? 'BloodExplosiveManager';
    this.explosionRadius = data?.explosionRadius ?? 5;
    this.explosionDamage = data?.explosionDamage ?? 40;
    this.getBlood = data?.getBlood ?? null;
  }

  // ── Update loop ───────────────────────────────────────────────────────────

  public update(dt: number, camera: CameraComponent | null): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.BLOOD_EXPLOSIVE)) return;
    if (this.cooldownTimer > 0) return;
    if (!camera) return;

    const blood = this.getBlood?.();
    if (blood && blood.getBlood() < this.bloodCost) {
      console.log('[BloodExplosive] Not enough blood.');
      return;
    }

    blood?.spendClamped(this.bloodCost);
    this.cooldownTimer = this.cooldown;
    this.fireExplosive(camera);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private fireExplosive(camera: CameraComponent): void {
    if (!this.pool) {
      const entity = Engine.getEntities().getEntityByName(this.poolName);
      this.pool = (entity?.getComponent('bullet_pool') as BulletPoolComponent) ?? null;
      if (!this.pool) {
        console.warn(`[BloodExplosiveSystem] No bullet_pool found on entity "${this.poolName}"`);
        return;
      }
    }

    const explosive = this.pool.acquire() as BloodExplosiveProjectileComponent | null;
    if (!explosive) return;

    const cam = camera.getCamera();
    const origin = cam.getPosition() as vec3;
    const dir = cam.getFront() as vec3;

    explosive.setExplosionParams(this.explosionRadius, this.explosionDamage);

    // Muzzle slightly in front of camera to avoid self-collision
    const muzzle = vec3.scaleAndAdd(vec3.create(), origin, dir, 0.8);
    explosive.fire(muzzle, dir, this.pool.release.bind(this.pool));
  }
}
