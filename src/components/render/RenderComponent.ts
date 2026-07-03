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
    if (!folder || !this.parts.length) return;

    const rFolder = folder.addFolder('Render');
    rFolder.close();

    // ── Component-level ──────────────────────────────────────────────────────
    const compState = { visible: this._isVisible };
    rFolder
      .add(compState, 'visible')
      .name('Visible')
      .onChange((v: boolean) => {
        this._isVisible = v;
        compState.visible = v;
        this.updateRenderManager();
      });

    const instanceState = { instanced: this.isInstanced, group: this.instanceGroup || '—' };
    rFolder.add(instanceState, 'instanced').name('Instanced').disable();
    if (this.isInstanced) {
      rFolder.add(instanceState, 'group').name('Instance Group').disable();
    }

    // ── One sub-folder per mesh part ─────────────────────────────────────────
    this.parts.forEach((part, i) => {
      const meshShortName = part.mesh.getName().split('/').pop() ?? `part${i}`;
      const pFolder = rFolder.addFolder(`Part ${i}  ·  ${meshShortName}`);
      pFolder.close();

      // Per-part visibility — lil-gui writes directly to part.isVisible via .add()
      pFolder
        .add(part, 'isVisible')
        .name('Visible')
        .listen()
        .onChange(() => { if (!this.isInstanced) this.updateRenderManager(); });

      // ── Mesh ───────────────────────────────────────────────────────────────
      const meshFolder = pFolder.addFolder('Mesh');
      meshFolder.close();
      const meshProxy = {
        name:     part.mesh.getName().split('/').pop() ?? part.mesh.getName(),
        vertices: part.mesh.getVertexCount(),
        indices:  part.mesh.getIndexCount(),
      };
      meshFolder.add(meshProxy, 'name').name('Name').disable();
      meshFolder.add(meshProxy, 'vertices').name('Vertices').disable();
      meshFolder.add(meshProxy, 'indices').name('Indices').disable();

      // ── Material ───────────────────────────────────────────────────────────
      const mat = part.material;
      const matFolder = pFolder.addFolder('Material');
      matFolder.close();
      const matProxy = {
        name:            mat.getName().split('/').pop() ?? mat.getName(),
        category:        mat.getCategory(),
        castsShadows:    mat.getCastsShadows(),
        receivesShadows: mat.getShadows(),
        roughness:       mat.getRoughnessFactor(),
        metallic:        mat.getMetallicFactor(),
        emissive:        mat.getEmissiveFactor(),
        uvX:             mat.getUvXScale(),
        uvY:             mat.getUvYScale(),
        appearanceBlend: mat.getAppearanceBlend(),
        surfaceBlend:    mat.getSurfaceBlend(),
        pomScale:        mat.getPomScale(),
      };
      matFolder.add(matProxy, 'name').name('Name').disable();
      matFolder.add(matProxy, 'category').name('Category').disable();
      matFolder.add(matProxy, 'castsShadows').name('Casts Shadows').disable();
      matFolder.add(matProxy, 'receivesShadows').name('Receives Shadows').disable();
      matFolder.add(matProxy, 'roughness', 0, 2, 0.01).name('Roughness').listen()
        .onChange((v: number) => mat.setFactors({ roughnessFactor: v }));
      matFolder.add(matProxy, 'metallic', 0, 1, 0.01).name('Metallic').listen()
        .onChange((v: number) => mat.setFactors({ metallicFactor: v }));
      matFolder.add(matProxy, 'emissive', 0, 5, 0.05).name('Emissive').listen()
        .onChange((v: number) => mat.setFactors({ emissiveFactor: v }));
      matFolder.add(matProxy, 'uvX', 0.1, 50, 0.1).name('UV Scale X').listen()
        .onChange((v: number) => mat.setFactors({ uvXScale: v }));
      matFolder.add(matProxy, 'uvY', 0.1, 50, 0.1).name('UV Scale Y').listen()
        .onChange((v: number) => mat.setFactors({ uvYScale: v }));
      matFolder.add(matProxy, 'appearanceBlend', 0, 1, 0.01).name('Appearance Blend').listen()
        .onChange((v: number) => mat.setFactors({ appearanceBlend: v }));
      matFolder.add(matProxy, 'surfaceBlend', 0, 1, 0.01).name('Surface Blend').listen()
        .onChange((v: number) => mat.setFactors({ surfaceBlend: v }));
      matFolder.add(matProxy, 'pomScale', 0, 0.2, 0.001).name('POM Scale').listen()
        .onChange((v: number) => mat.setFactors({ pomScale: v }));

      // ── Technique ──────────────────────────────────────────────────────────
      const tech = mat.getTechnique();
      if (tech) {
        const techFolder = pFolder.addFolder('Technique');
        techFolder.close();
        const vsShort = tech.getVsFile().split('/').pop() ?? tech.getVsFile();
        const fsRaw   = tech.getFsFile();
        const fsShort = fsRaw ? (fsRaw.split('/').pop() ?? fsRaw) : '—';
        const techProxy = {
          name:        tech.getName().split('/').pop() ?? tech.getName(),
          vs:          vsShort,
          fs:          fsShort,
          blend:       tech.getBlendMode(),
          depth:       tech.getDepthTest(),
          raster:      tech.getRasterizationMode(),
          skipPrepass: tech.getSkipDepthPrepass(),
          skinned:     tech.getIsSkinned(),
        };
        techFolder.add(techProxy, 'name').name('Name').disable();
        techFolder.add(techProxy, 'vs').name('Vertex Shader').disable();
        techFolder.add(techProxy, 'fs').name('Fragment Shader').disable();
        techFolder.add(techProxy, 'blend').name('Blend').disable();
        techFolder.add(techProxy, 'depth').name('Depth').disable();
        techFolder.add(techProxy, 'raster').name('Rasterization').disable();
        techFolder.add(techProxy, 'skipPrepass').name('Skip Prepass').disable();
        techFolder.add(techProxy, 'skinned').name('Skinned').disable();
      }
    });
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
