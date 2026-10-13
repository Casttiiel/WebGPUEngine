import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';
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
  /** Skip this key in the depth prepass (for vertex-animated geometry like wind grass). */
  skipDepthPrepass?: boolean;
  /** Override technique used only during the depth prepass for this key. */
  customPrepassTechnique?: Technique;
  id: number;
}

/**
 * Manages render keys and their lifecycle
 */
export class RenderKeyManager {
  private keys: RenderKey[] = [];
  private nextObjectId = 0;
  /** Registered keys per category, so passes can be skipped without filtering every frame. */
  private categoryCounts = new Map<RenderCategory, number>();

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
    skipDepthPrepass?: boolean,
    customPrepassTechnique?: Technique,
  ): void {
    if (!material) {
      return;
    }
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
      ...(skipDepthPrepass !== undefined && { skipDepthPrepass }),
      ...(customPrepassTechnique !== undefined && { customPrepassTechnique }),
      id: this.nextObjectId++,
    };

    this.keys.push(key);
    const category = material.getCategory();
    this.categoryCounts.set(category, (this.categoryCounts.get(category) ?? 0) + 1);
  }

  /**
   * Removes all keys for a specific owner
   */
  public removeKeys(owner: RenderComponent): void {
    this.keys = this.keys.filter((key) => {
      if (key.owner !== owner) return true;
      const category = key.material.getCategory();
      this.categoryCounts.set(category, (this.categoryCounts.get(category) ?? 1) - 1);
      return false;
    });
  }

  /** True when at least one registered key uses this category (O(1)). */
  public hasCategory(category: RenderCategory): boolean {
    return (this.categoryCounts.get(category) ?? 0) > 0;
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

      // Plain code-unit comparison: only grouping matters here, and localeCompare is
      // far slower (it runs O(n log n) times per pass, every frame).
      const techPath1 = tech1.path || '';
      const techPath2 = tech2.path || '';
      if (techPath1 !== techPath2) {
        return techPath1 < techPath2 ? -1 : 1;
      }

      // 2. Sort by material to minimize bind group changes
      const mat1 = k1.material.getName();
      const mat2 = k2.material.getName();
      if (mat1 !== mat2) {
        return mat1 < mat2 ? -1 : 1;
      }

      // 3. Sort by mesh to minimize vertex buffer changes
      const mesh1 = k1.mesh.getName();
      const mesh2 = k2.mesh.getName();
      return mesh1 === mesh2 ? 0 : mesh1 < mesh2 ? -1 : 1;
    });
  }

  private sortDistScratch = new Map<RenderKey, number>();

  /**
   * Sorts transparent objects by depth (back to front)
   */
  private sortTransparentsByDepth(keys: RenderKey[], camera: Camera): void {
    const cameraPos = camera.getPosition();

    // Squared distance per key computed once (getWorldMatrix() allocates a new mat4 per
    // call, and the comparator used to call it twice per comparison).
    const dist = this.sortDistScratch;
    dist.clear();
    for (const key of keys) {
      const p = key.transform.getTransform().getWorldPosition();
      dist.set(key, vec3.squaredDistance(cameraPos, p));
    }
    keys.sort((k1, k2) => dist.get(k2)! - dist.get(k1)!); // Far to near
  }

  /**
   * Clears all keys
   */
  public clear(): void {
    this.keys = [];
    this.categoryCounts.clear();
    this.nextObjectId = 0;
  }
}
