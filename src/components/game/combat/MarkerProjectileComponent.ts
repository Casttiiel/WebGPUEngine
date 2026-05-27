import { vec3 } from 'gl-matrix';
import RAPIER from '@dimforge/rapier3d';
import { ProjectileComponent } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';
import { HealthComponent } from '../HealthComponent';
import type { MarkSystem } from './MarkSystem';

/**
 * MarkerProjectileComponent — physical projectile for Lynx marker shots.
 *
 * Extends ProjectileComponent to also register a mark on the hit entity
 * (via MarkSystem) in addition to dealing damage.
 * The mark context is injected by MarkerShotSystem before each fire() call.
 */
export class MarkerProjectileComponent extends ProjectileComponent {
  private markSystem: MarkSystem | null = null;
  private markDuration: number = 15;

  /** Called by MarkerShotSystem before fire() to inject mark context. */
  public setMarkContext(markSystem: MarkSystem, duration: number): void {
    this.markSystem = markSystem;
    this.markDuration = duration;
  }

  protected override onHit(hitPoint: vec3, hit: RAPIER.RayColliderHit): void {
    const physics = Engine.getPhysics();
    const entityId = physics.getEntityIdFromCollider(hit.collider.handle);
    const entity = entityId !== undefined ? Engine.getEntities().getEntityById(entityId) : null;
    const isEnemy = entity?.getComponent('health') instanceof HealthComponent;

    if (isEnemy && entityId !== undefined) {
      // Enemy hit: deal damage, mark, disappear
      super.onHit(hitPoint, hit); // damage + doRelease()
      this.markSystem?.markEnemy(entityId, this.markDuration);
    } else {
      // Surface hit: plant a world mark at the impact point, bullet disappears
      this.markSystem?.addWorldMark(hitPoint, this.markDuration);
      this.doRelease();
    }

    this.markSystem = null;
  }
}
