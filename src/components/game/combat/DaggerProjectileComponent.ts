import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { ProjectileComponent } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';

/**
 * DaggerProjectileComponent — Extiende ProjectileComponent para añadir
 * detección de objetivos de grapple.
 *
 * Si la daga impacta un collider que pertenece a una entidad con
 * GrappleHookComponent, invoca el callback onGrappleHit en vez de
 * simplemente liberarse. En cualquier otro caso se comporta igual que
 * un proyectil normal.
 */
export class DaggerProjectileComponent extends ProjectileComponent {
  /** Callback instalado por ThrowSystem para iniciar el grapple. */
  private onGrappleHit: ((hitPoint: vec3) => void) | null = null;

  /** Registra el callback de grapple. Llamado por ThrowSystem.fire(). */
  public setGrappleCallback(cb: (hitPoint: vec3) => void): void {
    this.onGrappleHit = cb;
  }

  protected override onHit(hitPoint: vec3, hit: RAPIER.RayColliderHit): void {
    // Check if the hit entity is a grapple target; if so, invoke the grapple callback
    const entityId = Engine.getPhysics().getEntityIdFromCollider(hit.collider.handle);
    if (entityId !== undefined) {
      const entity = Engine.getEntities().getEntityById(entityId);
      const isGrappleTarget = entity?.getComponent('grapple_target') != null;
      if (isGrappleTarget && this.onGrappleHit) {
        this.onGrappleHit(hitPoint);
      }
    }

    // Base class handles damage + doRelease()
    super.onHit(hitPoint, hit);
  }
}
