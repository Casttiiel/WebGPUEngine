import { vec3 } from 'gl-matrix';
import { ColliderComponent, ColliderData, ColliderType } from './ColliderComponent';
import { Engine } from '../../core/engine/Engine';

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
    const colliderData = {
      ...data,
      colliderType: ColliderType.CUBOID,
      dimensions: [halfExtents[0], halfExtents[1], halfExtents[2]],
    } as ColliderData;

    // Llamar al load del componente base
    await super.load(colliderData);
  }

  public override async load(data: unknown): Promise<void> {
    await this.loadBox(data as BoxColliderData);
  }

  public override renderDebug(): void {
    // TODO: Implementar debug rendering (wireframe del box)
  }

  /**
   * Returns the current half-extents of the collider as stored in Rapier.
   */
  public getHalfExtents(): vec3 {
    if (!this.collider) return vec3.fromValues(0.5, 0.5, 0.5);
    const shape = this.collider.shape as any;
    if (shape?.halfExtents) {
      return vec3.fromValues(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    }
    return vec3.fromValues(0.5, 0.5, 0.5);
  }

  /**
   * Resizes the box collider to newSize (full dimensions, not half-extents).
   * Removes the old Rapier collider and creates a new one preserving sensor/group settings.
   */
  public resizeBox(newSize: vec3): void {
    if (!this.collider || !this.rigidBody) return;

    const physics = Engine.getPhysics();
    const currentGroups = this.collider.collisionGroups();

    // Remove old collider from Rapier world and tracking maps
    physics.removeColliderEntry(this.collider, this.getOwner().id);

    // Create new cuboid with updated half-extents
    const halfExtents = vec3.fromValues(newSize[0] / 2, newSize[1] / 2, newSize[2] / 2);
    const newCollider = physics.addCuboidCollider(
      this.getOwner().id,
      this.rigidBody,
      halfExtents,
      this.isSensor,
    );
    newCollider.setCollisionGroups(currentGroups);
    this.collider = newCollider;
  }
}
