import { vec3 } from 'gl-matrix';
import { ColliderComponent, ColliderData, ColliderType } from './ColliderComponent';

export interface SphereColliderData extends Omit<ColliderData, 'colliderType' | 'dimensions'> {
  radius: number; // Radio de la esfera
}

/**
 * SphereColliderComponent - Collider de esfera
 *
 * Usa un collider de tipo SPHERE internamente.
 * Las dimensiones se pasan como halfExtents (mitad del tamaño).
 */
export class SphereColliderComponent extends ColliderComponent {
  public async loadSphere(data: SphereColliderData): Promise<void> {
    // Convertir tamaño completo a halfExtents para Rapier
    const halfExtents = vec3.fromValues(data.radius, data.radius, data.radius);

    // Crear configuración del collider con tipo SPHERE
    const colliderData = {
      ...data,
      colliderType: ColliderType.SPHERE,
      dimensions: [halfExtents[0]],
    } as ColliderData;

    // Llamar al load del componente base
    await super.load(colliderData);
  }

  public override async load(data: unknown): Promise<void> {
    await this.loadSphere(data as SphereColliderData);
  }

}
