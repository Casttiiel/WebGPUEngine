import { vec3 } from 'gl-matrix';
import { ColliderComponent, ColliderData, ColliderType } from './ColliderComponent';

export interface BoxColliderData extends Omit<ColliderData, 'colliderType' | 'dimensions'> {
  size: vec3; // Tamaño completo del box [width, height, depth]
}

/**
 * BoxColliderComponent - Collider de caja (cuboid)
 *
 * Usa un collider de tipo CUBOID internamente.
 * Las dimensiones se pasan como halfExtents (mitad del tamaño).
 */
export class BoxColliderComponent extends ColliderComponent {
  public async loadBox(data: BoxColliderData): Promise<void> {
    // Convertir tamaño completo a halfExtents para Rapier
    const halfExtents = vec3.fromValues(data.size[0] / 2, data.size[1] / 2, data.size[2] / 2);

    // Crear configuración del collider con tipo CUBOID
    const colliderData: ColliderData = {
      ...data,
      colliderType: ColliderType.CUBOID,
      dimensions: [halfExtents[0], halfExtents[1], halfExtents[2]],
    };

    // Llamar al load del componente base
    await super.load(colliderData);
  }

  public override async load(data: unknown): Promise<void> {
    await this.loadBox(data as BoxColliderData);
  }

  public override renderInMenu(): void {
    // TODO: Implementar debug UI
  }

  public override renderDebug(): void {
    // TODO: Implementar debug rendering (wireframe del box)
  }
}
