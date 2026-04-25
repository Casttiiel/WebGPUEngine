import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { ProjectileComponent } from '../ProjectileComponent';
import { Engine } from '../../../core/engine/Engine';
import { GrappleHookComponent } from '../GrappleHookComponent';

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
    // Intentar resolver la entidad golpeada
    const entityId = Engine.getPhysics().getEntityIdFromCollider(hit.collider.handle);

    if (entityId !== undefined) {
      const entity = Engine.getEntities().getEntityById(entityId);
      const isGrappleTarget = entity?.getComponent('grapple_hook') != null;

      if (isGrappleTarget && this.onGrappleHit) {
        // La daga se "queda clavada" — sólo la liberamos del pool, no llamamos release
        // (el pool la recuperará via el release normal cuando el grapple termine o
        //  la daga salga de rango por el padre ProjectileComponent)
        this.onGrappleHit(hitPoint);
        // Después de notificar, la daga vuelve al pool normalmente
        super.onHit(hitPoint, hit);
        return;
      }
    }

    // Impacto normal (pared, suelo, enemigo, etc.)
    super.onHit(hitPoint, hit);
  }
}
