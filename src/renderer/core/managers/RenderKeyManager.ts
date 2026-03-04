import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { vec3 } from 'gl-matrix';
import { AABB } from '../../../types/AABB';

export interface RenderKey {
  mesh: Mesh;
  material: Material;
  owner: RenderComponent;
  transform: TransformComponent;
  aabb: AABB | null;
  isInstanced: boolean;
  instanceCount: number; // Required for both instanced and non-instanced (defaults to 1)
  instanceBindGroup?: GPUBindGroup | undefined; // Bind group with storage buffer for instanced rendering (@group(2))
  renderBindGroup?: GPUBindGroup | undefined; // Optional bind group for custom rendering (e.g. particles)
  indirectDrawBuffer?: GPUBuffer | undefined; // Optional indirect draw buffer for GPU-driven rendering
  indirectDrawOffset: number; // Byte offset into indirectDrawBuffer (0 for dedicated per-key buffers)
  shadowIndirectOffset: number; // Byte offset into the per-dispatch shadow indirect buffer (-1 = not GPU shadow culled)
  id: number;
}

/**
 * Manages render keys and their lifecycle
 */
export class RenderKeyManager {
  private keys: RenderKey[] = [];
  private nextObjectId = 0;

  /**
   * Adds a new render key
   */
  public addKey(
    owner: RenderComponent,
    mesh: Mesh,
    material: Material,
    transform: TransformComponent,
    isInstanced: boolean = false,
    instanceCount: number = 1,
    instanceBindGroup?: GPUBindGroup,
    renderBindGroup?: GPUBindGroup,
    indirectDrawBuffer?: GPUBuffer,
  ): void {
    const key: RenderKey = {
      mesh,
      material,
      owner,
      transform,
      aabb: mesh.getAABB(),
      isInstanced,
      instanceCount: isInstanced ? instanceCount : 1,
      instanceBindGroup,
      renderBindGroup,
      indirectDrawBuffer,
      indirectDrawOffset: 0,
      shadowIndirectOffset: -1,
      id: this.nextObjectId++,
    };

    this.keys.push(key);
  }

  /**
   * Removes all keys for a specific owner
   */
  public removeKeys(owner: RenderComponent): void {
    this.keys = this.keys.filter((key) => key.owner !== owner);
  }

  /**
   * Gets all keys
   */
  public getAllKeys(): RenderKey[] {
    return this.keys;
  }

  /**
   * Filters keys by category
   */
  public getKeysByCategory(category: RenderCategory): RenderKey[] {
    return this.keys.filter((key) => key.material.getCategory() === category);
  }

  /**
   * Sorts render keys for optimal rendering
   */
  public sortKeys(keys: RenderKey[], category: RenderCategory, camera?: Camera): void {
    if (category === RenderCategory.TRANSPARENT && camera) {
      this.sortTransparentsByDepth(keys, camera);
      return;
    }

    // For opaque objects, sort by state to minimize pipeline changes
    keys.sort((k1, k2) => {
      // 1. Sort by technique to minimize pipeline changes
      const tech1 = k1.material.getTechnique();
      const tech2 = k2.material.getTechnique();
      if (!tech1 || !tech2) return 0;

      const techPath1 = tech1.path || '';
      const techPath2 = tech2.path || '';
      if (techPath1 !== techPath2) {
        return techPath1.localeCompare(techPath2);
      }

      // 2. Sort by material to minimize bind group changes
      const mat1 = k1.material.getName();
      const mat2 = k2.material.getName();
      if (mat1 !== mat2) {
        return mat1.localeCompare(mat2);
      }

      // 3. Sort by mesh to minimize vertex buffer changes
      const mesh1 = k1.mesh.getName();
      const mesh2 = k2.mesh.getName();
      return mesh1.localeCompare(mesh2);
    });
  }

  /**
   * Sorts transparent objects by depth (back to front)
   */
  private sortTransparentsByDepth(keys: RenderKey[], camera: Camera): void {
    const cameraPos = camera.getPosition();

    keys.sort((k1, k2) => {
      const worldMatrix1 = k1.transform.getTransform().getWorldMatrix();
      const worldMatrix2 = k2.transform.getTransform().getWorldMatrix();

      if (!worldMatrix1 || !worldMatrix2) return 0;

      // Extract position from world matrix (last column)
      const pos1 = vec3.fromValues(worldMatrix1[12], worldMatrix1[13], worldMatrix1[14]);
      const pos2 = vec3.fromValues(worldMatrix2[12], worldMatrix2[13], worldMatrix2[14]);

      // Calculate distances using vec3 operations
      const dist1 = vec3.distance(cameraPos, pos1);
      const dist2 = vec3.distance(cameraPos, pos2);

      return dist2 - dist1; // Far to near
    });
  }

  /**
   * Clears all keys
   */
  public clear(): void {
    this.keys = [];
    this.nextObjectId = 0;
  }
}
