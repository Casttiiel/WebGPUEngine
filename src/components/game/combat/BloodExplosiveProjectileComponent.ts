import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { ProjectileComponent, ProjectileComponentData } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { Msg } from '../../../core/ecs/Msg';
import { BestialitySystem } from './BestialitySystem';

export type BloodExplosiveProjectileData = ProjectileComponentData & {
  /** Explosion radius in metres. Default 5. */
  explosionRadius?: number;
  /** Instant damage dealt to each enemy within the explosion radius. Default 40. */
  explosionDamage?: number;
};

/**
 * BloodExplosiveProjectileComponent — A blood projectile that explodes on impact.
 *
 * Travels in a slight arc (gravity-affected). On hit it instantly deals burst
 * AoE damage to all enemies within the explosion radius. No lingering zone.
 * Designed for taking out groups of clustered enemies.
 *
 * Triggered by GameAction.BLOOD_EXPLOSIVE (right-click) via BloodExplosiveSystem.
 */
export class BloodExplosiveProjectileComponent extends ProjectileComponent {
  private explosionRadius: number = 5;
  private explosionDamage: number = 40;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public override load(data: BloodExplosiveProjectileData): void {
    const filled: BloodExplosiveProjectileData = {
      speed: data?.speed ?? 14,
      maxRange: data?.maxRange ?? 30,
      damage: data?.damage ?? 0,
      gravity: data?.gravity ?? 4,
      ...data,
    };
    super.load(filled);

    this.explosionRadius = data?.explosionRadius ?? this.explosionRadius;
    this.explosionDamage = data?.explosionDamage ?? this.explosionDamage;

    // Start disabled — BloodExplosiveSystem calls fire() after acquiring from pool
    this.enabled = false;
  }

  /**
   * Override explosion parameters at runtime (called by BloodExplosiveSystem
   * to use system-level config rather than prefab defaults).
   */
  public setExplosionParams(radius: number, damage: number): void {
    this.explosionRadius = radius;
    this.explosionDamage = damage;
  }

  // ── Hit handling ──────────────────────────────────────────────────────────

  protected override onHit(hitPoint: vec3, hit: RAPIER.RayColliderHit): void {
    this.explode(hitPoint);
    super.onHit(hitPoint, hit);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private explode(center: vec3): void {
    let totalDamage = 0;

    for (const entity of Engine.getEntities().getAllEntities()) {
      if (!entity.getComponent('enemy_controller')) continue;

      const tc = entity.getComponent('transform') as TransformComponent | null;
      if (!tc) continue;

      const pos = tc.getTransform().getWorldPosition() as vec3;
      if (vec3.distance(center, pos) > this.explosionRadius) continue;

      entity.sendMsg(Msg.damage({ amount: this.explosionDamage, instigator: null }));
      totalDamage += this.explosionDamage;
    }

    if (totalDamage > 0) {
      BestialitySystem.notify(totalDamage * 0.5);
    }
  }
}
