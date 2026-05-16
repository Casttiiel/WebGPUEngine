import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { ProjectileComponent, ProjectileComponentData } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';

export type BloodBallProjectileData = ProjectileComponentData & {
  /** AoE radius of the zone spawned on impact. Default 4. */
  zoneRadius?: number;
  /** How many seconds the zone persists. Default 9. */
  zoneDuration?: number;
  /** Damage per second dealt inside the zone. Default 5. */
  zoneDamagePerSecond?: number;
  /** Speed multiplier applied to enemies inside (0..1). Default 0.4. */
  zoneSlowFactor?: number;
};

/**
 * BloodBallProjectileComponent — A slow, gravity-affected blood projectile.
 *
 * Travels in an arc. On impact (or max-range expiry) it:
 *   1. Spawns a BloodZoneComponent entity at the hit point.
 *   2. Destroys itself via the release callback.
 *
 * Designed to be dynamically spawned by BloodZoneSystem (no pool needed).
 */
export class BloodBallProjectileComponent extends ProjectileComponent {
  private zoneRadius: number = 4;
  private zoneDuration: number = 9;
  private zoneDamagePerSecond: number = 5;
  private zoneSlowFactor: number = 0.4;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public override load(data: BloodBallProjectileData): void {
    // Defaults: slower than dagger, noticeable gravity arc
    const filled: BloodBallProjectileData = {
      speed: data?.speed ?? 12,
      maxRange: data?.maxRange ?? 25,
      damage: data?.damage ?? 0,
      gravity: data?.gravity ?? 6,
      ...data,
    };
    super.load(filled);

    this.zoneRadius = data?.zoneRadius ?? this.zoneRadius;
    this.zoneDuration = data?.zoneDuration ?? this.zoneDuration;
    this.zoneDamagePerSecond = data?.zoneDamagePerSecond ?? this.zoneDamagePerSecond;
    this.zoneSlowFactor = data?.zoneSlowFactor ?? this.zoneSlowFactor;

    // Start disabled — BloodZoneSystem calls fire() after the entity is ready
    this.enabled = false;
  }

  // ── Hit handling ──────────────────────────────────────────────────────────

  protected override onHit(hitPoint: vec3, _hit: RAPIER.RayColliderHit): void {
    this.spawnZone(hitPoint);
    // Release (destroys the dynamically spawned entity via the callback set in fire())
    super.onHit(hitPoint, _hit);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private spawnZone(center: vec3): void {
    const entityData = {
      components: {
        name: 'BloodZone',
        transform: {
          position: [center[0], center[1], center[2]] as [number, number, number],
        },
        blood_zone: {
          center: [center[0], center[1], center[2]] as [number, number, number],
          radius: this.zoneRadius,
          duration: this.zoneDuration,
          damagePerSecond: this.zoneDamagePerSecond,
          slowFactor: this.zoneSlowFactor,
        },
      },
    } as unknown as EntityDataType;

    Loader.loadEntityFromJSON(entityData, undefined, false).catch((e) =>
      console.error('[BloodBallProjectile] Failed to spawn zone:', e),
    );
  }
}
