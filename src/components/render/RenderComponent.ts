import { Component } from '../../core/ecs/Component';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { TransformComponent } from '../core/TransformComponent';
import {
  RenderComponentDataType,
  RenderComponentMeshDataType,
} from '../../types/RenderComponentData.type';
import { MeshPartType } from '../../types/MeshPart.type';
import { MeshData } from '../../types/MeshData.type';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';

export class RenderComponent extends Component {
  private isVisible: boolean = true;
  private parts: MeshPartType[] = [];

  constructor() {
    super();
  }

  public async load(data: RenderComponentDataType): Promise<void> {
    if (data.meshes) {
      for (const meshData of data.meshes) {
        await this.readMesh(meshData);
      }
    }

    this.updateRenderManager();
  }

  private async readMesh(data: RenderComponentMeshDataType): Promise<void> {
    try {
      // Handle mesh loading - priority to mesh string path over meshData
      let mesh: Mesh;
      if (data.mesh) {
        mesh = await Mesh.get(data.mesh);
      } else if (data.meshData) {
        // Cast the meshData structure to the expected MeshData format
        // This is safe because GLTFLoader creates this structure correctly
        const meshData = data.meshData as MeshData;
        mesh = await Mesh.get(meshData);
      } else {
        throw new Error('No mesh file specified in RenderComponent data');
      }

      if (!mesh) {
        throw new Error('Failed to load mesh');
      }

      // Handle material loading - ensure we have material data
      let material: Material;
      if (data.material) {
        material = await Material.get(data.material);
      } else if (data.materialData) {
        material = await Material.get(data.materialData);
      } else {
        throw new Error('No material specified in RenderComponent data');
      }

      if (!material) {
        throw new Error('Failed to load material');
      }

      const meshPart: MeshPartType = {
        mesh,
        material,
        isVisible: data.visible !== undefined ? data.visible : true,
      };

      this.parts.push(meshPart);
    } catch (error) {
      console.error('Error in readMesh:', error);
      throw error;
    }
  }

  private updateRenderManager(): void {
    const renderManager = RenderManager.getInstance();
    const entity = this.getOwner();
    const transformComponent = entity.getComponent('transform') as TransformComponent;

    renderManager.delKeys(this);

    for (const part of this.parts) {
      if (!part.isVisible || !this.isVisible) continue;
      renderManager.addKey(this, part.mesh, part.material, transformComponent);
    }
  }

  public update(_dt: number): void {
    // Unused dt parameter is prefixed with underscore
    // Implementation of update if needed
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
