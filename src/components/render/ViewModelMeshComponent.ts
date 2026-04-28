import { Component } from '../../core/ecs/Component';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { TransformComponent } from '../core/TransformComponent';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';

export interface ViewModelMeshData {
  /** Mesh asset path (e.g. "weapons/sword.obj") */
  mesh: string;
  /** Material asset path – material must have category: "view_model" */
  material: string;
}

/**
 * ViewModelMeshComponent
 *
 * Registers a mesh+material pair into the VIEW_MODEL render category so it is drawn
 * by ViewModelPass with its own depth buffer and identity-view camera.
 *
 * The entity's TransformComponent is updated each frame by ViewModelComponent to
 * reflect camera-space placement (socket offset + procedural + animation offsets).
 *
 * Material requirements:
 *   • category: "view_model"   — routes to ViewModelPass, bypasses GPU frustum culling
 *   • casts_shadows: false     — weapons don't cast world shadows
 */
export class ViewModelMeshComponent extends Component {
  private mesh: Mesh | null = null;
  private material: Material | null = null;

  public async load(data: ViewModelMeshData): Promise<void> {
    this.mesh = Mesh.get(data.mesh);
    this.material = await Material.get(data.material);

    if (!this.mesh || !this.material) {
      console.error('ViewModelMeshComponent: failed to load mesh or material', data);
      return;
    }

    this.registerKey();
  }

  private registerKey(): void {
    if (!this.mesh || !this.material) return;
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!transform) {
      console.warn('ViewModelMeshComponent: owner has no TransformComponent');
      return;
    }
    const rm = RenderManager.getInstance();
    rm.delKeys(this as any);
    rm.addKey(this as any, this.mesh, this.material, transform);
  }

  public dispose(): void {
    RenderManager.getInstance().delKeys(this as any);
    this.mesh = null;
    this.material = null;
  }

  public getMesh(): Mesh | null {
    return this.mesh;
  }

  public getMaterial(): Material | null {
    return this.material;
  }
}
