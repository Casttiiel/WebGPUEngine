import { Component } from '../../core/ecs/Component';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/material';
import { TransformComponent } from '../core/TransformComponent';
import {
  RenderComponentDataType,
  RenderComponentMeshDataType,
} from '../../types/RenderComponentData.type';
import { MeshPartType } from '../../types/MeshPart.type';
import { RenderManager } from '../../renderer/core/RenderManager';

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
      const meshFile = data.mesh ?? data.meshData;
      if (!meshFile) {
        throw new Error('No mesh file specified in RenderComponent data');
      }

      const mesh = await Mesh.get(meshFile);
      if (!mesh) {
        throw new Error(`Failed to load mesh: ${meshFile}`);
      }

      // Load material first but don't create bind group yet
      const material = await this.loadMaterial(data);
      if (!material) {
        throw new Error('Failed to load material');
      }
      this.material = material;

      // Get technique from material
      const technique = material.getTechnique();
      if (!technique) {
        throw new Error('No technique found in material');
      }

      // Get pipeline
      const renderPipeline = await technique.getPipeline();
      if (!renderPipeline) {
        throw new Error('Failed to get render pipeline');
      }

      // Now create material bind group using pipeline layout
      await material.createBindGroup(renderPipeline);

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

  private async loadMaterial(data: RenderComponentMeshDataType): Promise<Material> {
    const materialData = data.material ?? data.materialData;
    if (!materialData) {
      throw new Error('No material specified in RenderComponent data');
    }

    return Material.get(materialData);
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

  public renderInMenu(): void {}

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
