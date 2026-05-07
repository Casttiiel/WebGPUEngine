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
import { Engine } from '../../core/engine/Engine';

export class RenderComponent extends Component {
  private _isVisible: boolean = true;
  private parts: MeshPartType[] = [];

  // Instancing support
  private isInstanced: boolean = false;
  private instanceGroup: string = '';

  constructor() {
    super();
  }

  public async load(data: RenderComponentDataType): Promise<void> {
    // Detectar si esta entity está marcada para instancing
    if (data.isInstanced === true && data.instanceGroup) {
      this.isInstanced = true;
      this.instanceGroup = data.instanceGroup;
    }

    if (data.meshes) {
      await Promise.all(data.meshes.map((meshData) => this.readMesh(meshData)));
    }

    // Solo actualizar RenderManager si NO es instanciada
    // Las entities instanciadas NO crean RenderKeys individuales
    if (!this.isInstanced) {
      this.updateRenderManager();
    }
  }

  private async readMesh(data: RenderComponentMeshDataType): Promise<void> {
    try {
      // Handle mesh loading - priority to mesh string path over meshData
      let mesh: Mesh;
      if (data.mesh) {
        mesh = Mesh.get(data.mesh);
      } else if (data.meshData) {
        // Cast the meshData structure to the expected MeshData format
        // This is safe because GLTFLoader creates this structure correctly
        const meshData = data.meshData as MeshData;
        mesh = Mesh.get(meshData);
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
      if (!part.isVisible || !this._isVisible) continue;
      renderManager.addKey(this, part.mesh, part.material, transformComponent);
    }
  }

  // Getters para acceso público (necesarios para InstanceManager)
  public getIsInstanced(): boolean {
    return this.isInstanced;
  }

  public getInstanceGroup(): string {
    return this.instanceGroup;
  }

  public getParts(): MeshPartType[] {
    return this.parts;
  }

  /**
   * Replaces the material on one part and re-registers the render key.
   * Used by the editor to assign per-entity material overrides.
   */
  public setPartMaterial(partIndex: number, material: Material): void {
    const part = this.parts[partIndex];
    if (!part) return;
    part.material = material;
    if (!this.isInstanced) {
      this.updateRenderManager();
    }
  }

  public isVisible(): boolean {
    return this._isVisible;
  }

  public update(_dt: number): void {
    // Unused dt parameter is prefixed with underscore
    // Implementation of update if needed
  }

  public override renderInMenu(): void {
    // Get the owner entity
    const entity = this.getOwner();
    const entityId = entity.id;
    const entityKey = `entity_${entityId}`;

    // Get the parent folder from the entity hierarchy
    let parentFolder = 'entities';
    const parentEntity = entity.getParent();
    if (parentEntity) {
      const parentId = parentEntity.id;
      const parentEntityKey = `entity_${parentId}`;
      // If this entity has a parent, it's in a subfolder
      parentFolder = `entities_${parentEntityKey}`;
    }

    // Create helper method to add controls to the entity's folder
    const addControl = (
      object: unknown,
      propertyKey: string,
      label: string,
      options?: { min?: number; max?: number; step?: number },
    ) => {
      const debugUI = Engine.getDebugUI();
      debugUI.addControlToSubFolder(parentFolder, entityKey, object, propertyKey, label, options);
    };

    // Show visibility toggle
    const visibilityControl = {
      get visible() {
        return this._visible;
      },
      set visible(value) {
        this._visible = value;
        this.component._isVisible = value;
        this.component.updateRenderManager();
      },
      _visible: this._isVisible,
      component: this,
    };

    addControl(visibilityControl, 'visible', 'Visible');

    // Show mesh and material information for each part
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (!part) continue;

      const partIndex = i;

      // Get the part path info from the resources
      const meshPath = part.mesh.path || `Mesh_${i}`;
      const materialPath = part.material.path || `Material_${i}`;
      const techniquePath = part.material.getTechnique()?.path || 'None';

      // Create info objects for display with just the names (no full paths)
      const meshInfo = {
        name: meshPath.split('/').pop() || meshPath,
      };

      const materialInfo = {
        name: materialPath.split('/').pop() || materialPath,
        category: part.material.getCategory(),
        techniqueName: techniquePath.split('/').pop() || techniquePath,
        castsShadows: part.material.getCastsShadows(),
        receiveShadows: part.material.getShadows(),
      };

      // Add mesh control - just the name
      addControl(meshInfo, 'name', `Mesh ${partIndex}`);

      // Add material controls - just the essential info
      addControl(materialInfo, 'name', `Material ${partIndex}`);
      addControl(materialInfo, 'category', `Category`);
      addControl(materialInfo, 'techniqueName', `Technique`);
      addControl(materialInfo, 'castsShadows', `Casts Shadows`);
      addControl(materialInfo, 'receiveShadows', `Receives Shadows`);

      // Part visibility toggle
      const partVisibility = {
        get visible() {
          return this._visible;
        },
        set visible(value) {
          this._visible = value;
          if (this.part) {
            this.part.isVisible = value;
            this.component.updateRenderManager();
          }
        },
        _visible: part.isVisible,
        part,
        component: this,
      };

      addControl(partVisibility, 'visible', `Mesh ${partIndex} Visible`);
    }
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
