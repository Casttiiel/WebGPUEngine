import { Component } from '../../core/ecs/Component';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { Texture } from '../../renderer/resources/Texture';
import { TransformComponent } from '../core/TransformComponent';
import {
  RenderComponentDataType,
  RenderComponentMeshDataType,
} from '../../types/RenderComponentData.type';
import { MeshPartType } from '../../types/MeshPart.type';
import { MeshData } from '../../types/MeshData.type';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { TextureStreamingManager } from '../../renderer/core/managers/TextureStreamingManager';

export class RenderComponent extends Component {
  private _isVisible: boolean = true;
  private parts: MeshPartType[] = [];

  // Instancing support
  private isInstanced: boolean = false;
  private instanceGroup: string = '';

  /** Cached position getter shared across all textures loaded by this component. */
  private streamingPosGetter: (() => import('gl-matrix').vec3) | null = null;
  /** All streamable textures registered with TextureStreamingManager (for cleanup). */
  private streamingTextures: Texture[] = [];

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

      // Register streamable textures with the streaming manager so they are
      // upgraded to full resolution when this entity comes within range.
      const entity = this.getOwner();
      const tc = entity?.getComponent('transform') as TransformComponent | undefined;
      if (tc) {
        if (!this.streamingPosGetter) {
          this.streamingPosGetter = () => tc.getTransform().getWorldPosition();
        }
        const tsm = TextureStreamingManager.getInstance();
        for (const tex of material.getAssetTextures()) {
          tsm.register(tex, this.streamingPosGetter);
          if (!this.streamingTextures.includes(tex)) {
            this.streamingTextures.push(tex);
          }
        }
      }
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
      const skipPrepass = part.material.getTechnique()?.getSkipDepthPrepass() ?? false;
      renderManager.addKey(
        this,
        part.mesh,
        part.material,
        transformComponent,
        false,
        1,
        undefined,
        undefined,
        undefined,
        skipPrepass || undefined,
      );
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (!this.parts.length) return;

    const mat = this.parts[0]?.material ?? null;
    if (!mat) return;

    const mFolder = folder.addFolder('Material');
    mFolder.close();

    const mp = {
      materialName: mat.getName().split('/').pop() ?? mat.getName(),
      roughnessFactor: mat.getRoughnessFactor(),
      metallicFactor: mat.getMetallicFactor(),
      emissiveFactor: mat.getEmissiveFactor(),
      uvXScale: mat.getUvXScale(),
      uvYScale: mat.getUvYScale(),
      appearanceBlend: mat.getAppearanceBlend(),
      surfaceBlend: mat.getSurfaceBlend(),
      pomScale: mat.getPomScale(),
    };

    mFolder.add(mp, 'materialName').name('Material').disable().listen();
    mFolder
      .add(mp, 'roughnessFactor', 0, 2, 0.01)
      .name('Roughness')
      .listen()
      .onChange((v: number) => mat.setFactors({ roughnessFactor: v }));
    mFolder
      .add(mp, 'metallicFactor', 0, 1, 0.01)
      .name('Metallic')
      .listen()
      .onChange((v: number) => mat.setFactors({ metallicFactor: v }));
    mFolder
      .add(mp, 'emissiveFactor', 0, 5, 0.05)
      .name('Emissive')
      .listen()
      .onChange((v: number) => mat.setFactors({ emissiveFactor: v }));
    mFolder
      .add(mp, 'uvXScale', 0.1, 50, 0.1)
      .name('UV Scale X')
      .listen()
      .onChange((v: number) => mat.setFactors({ uvXScale: v }));
    mFolder
      .add(mp, 'uvYScale', 0.1, 50, 0.1)
      .name('UV Scale Y')
      .listen()
      .onChange((v: number) => mat.setFactors({ uvYScale: v }));
    mFolder
      .add(mp, 'appearanceBlend', 0, 1, 0.01)
      .name('Appearance Blend')
      .listen()
      .onChange((v: number) => mat.setFactors({ appearanceBlend: v }));
    mFolder
      .add(mp, 'surfaceBlend', 0, 1, 0.01)
      .name('Surface Blend')
      .listen()
      .onChange((v: number) => mat.setFactors({ surfaceBlend: v }));
    mFolder
      .add(mp, 'pomScale', 0, 0.2, 0.001)
      .name('POM Scale')
      .listen()
      .onChange((v: number) => mat.setFactors({ pomScale: v }));
  }

  public override dispose(): void {
    RenderManager.getInstance().delKeys(this);

    // Unregister streaming textures so the manager stops tracking them.
    if (this.streamingPosGetter) {
      const tsm = TextureStreamingManager.getInstance();
      for (const tex of this.streamingTextures) {
        tsm.unregister(tex, this.streamingPosGetter);
      }
    }
    this.streamingTextures = [];
    this.streamingPosGetter = null;

    this.parts = [];
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
