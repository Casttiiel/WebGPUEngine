import { ColliderComponent, ColliderData, ColliderType, RigidBodyType } from './ColliderComponent';

export interface MeshColliderData
  extends Omit<ColliderData, 'colliderType' | 'dimensions' | 'bodyType'> {
  vertices: number[]; // Array de vértices [x, y, z, x, y, z, ...]
  indices: number[]; // Array de índices [i0, i1, i2, ...]
}

/**
 * MeshColliderComponent - Collider de malla triangular
 *
 * Usa un trimesh de Rapier para geometría compleja.
 * IMPORTANTE: Los mesh colliders solo funcionan con cuerpos estáticos.
 * Para cuerpos dinámicos, usar formas convexas simples (box, sphere, capsule).
 */
export class MeshColliderComponent extends ColliderComponent {
  public async loadMesh(data: MeshColliderData): Promise<void> {
    // Crear configuración del collider con tipo TRIMESH (siempre estático)
    const colliderData = {
      ...data,
      bodyType: RigidBodyType.STATIC, // Los trimesh siempre son estáticos
      colliderType: ColliderType.TRIMESH,
      dimensions: [], // No se usa para trimesh
    } as ColliderData;

    // Llamar al load del componente base
    await super.load(colliderData);
  }

  public override async load(data: unknown): Promise<void> {
    await this.loadMesh(data as MeshColliderData);
  }

}
