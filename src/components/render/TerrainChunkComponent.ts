// ---------------------------------------------------------------------------
// TerrainChunkComponent — one render+physics chunk of the terrain grid
// ---------------------------------------------------------------------------
// Phase 4: Per-chunk normal map texture generated from the full-res heightmap.
// Phase 5: MeshCollider (Rapier TRIMESH) at LOD0 for accurate physics.
// Phase 6: Distance-based LOD swap for render mesh only.
// Phase 7: Skirts emitted by TerrainMeshBuilder to hide LOD seams.
// Phase 8: Responds to terrainData dirty flag for brush deformation.
// Splat:   Per-chunk splat weight texture (height+slope → layer blend).
// ---------------------------------------------------------------------------

import { Component } from '../../core/ecs/Component';
import { RenderComponent } from './RenderComponent';
import { TerrainData } from '../../core/terrain/TerrainData';
import { TerrainMeshBuilder } from '../../core/terrain/TerrainMeshBuilder';
import { TerrainNormalMapGenerator } from '../../core/terrain/TerrainNormalMapGenerator';
import { TerrainSplatGenerator } from '../../core/terrain/TerrainSplatGenerator';
import { MeshColliderComponent } from '../physics/MeshColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { CameraComponent } from './CameraComponent';
import { Texture } from '../../renderer/resources/Texture';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { MaterialDataType } from '../../types/MaterialData.type';

// ---------------------------------------------------------------------------
// Data type passed programmatically from TerrainComponent.onAttach()
// ---------------------------------------------------------------------------
export interface TerrainChunkData {
  terrainData: TerrainData;
  chunkX: number;
  chunkZ: number;
  /** Material asset path (e.g., 'terrain_test.mat'). */
  materialPath: string;
  /** Whether to create a physics trimesh collider. Default: true. */
  physics?: boolean;
}

export class TerrainChunkComponent extends Component {
  private renderComp: RenderComponent | null = null;
  private physicsComp: MeshColliderComponent | null = null;
  private chunkData!: TerrainChunkData;

  // ── Phase 4: generated normal map ──────────────────────────────────────────
  /** GPU texture holding the chunk's procedural tangent-space normal map. */
  private normalMapTexture: Texture | null = null;

  // ── Splat: generated splat weight map ────────────────────────────────────
  /** GPU texture holding per-chunk splat weights (R=ground, G=rock, B=snow). */
  private splatMapTexture: Texture | null = null;

  /**
   * Per-process cache of raw .mat data so we don't re-fetch the file on
   * every LOD rebuild / brush stroke.
   */
  private static readonly matDataCache = new Map<string, MaterialDataType>();

  // ── LOD state ─────────────────────────────────────────────────────────────
  private currentLodLevel: number = 0;
  private isRebuilding: boolean = false;

  /**
   * Squared-distance thresholds for LOD transitions.
   * LOD0 when dist² < [0], LOD1 when < [1], LOD2 when < [2], LOD3 otherwise.
   */
  private static readonly LOD_DIST2: [number, number, number] = [80 * 80, 160 * 160, 320 * 320];

  // ---------------------------------------------------------------------------
  // Component lifecycle
  // ---------------------------------------------------------------------------

  async load(data: unknown): Promise<void> {
    this.chunkData = data as TerrainChunkData;
    await this.buildRenderMesh(0);
    await this.buildPhysicsCollider();
  }

  update(_dt: number): void {
    if (!this.chunkData) return;

    // ── Dirty rebuild (Phase 8: brush deformation) ────────────────────────
    const { terrainData, chunkX, chunkZ } = this.chunkData;
    if (terrainData.isDirty(chunkX, chunkZ)) {
      terrainData.clearDirty(chunkX, chunkZ);
      if (!this.isRebuilding) {
        this.rebuildChunk().catch((e) => console.error('[TerrainChunk] rebuild error', e));
      }
      return;
    }

    // ── LOD distance check (Phase 6) ─────────────────────────────────────
    if (!this.isRebuilding) {
      this.checkLOD();
    }
  }

  renderDebug(): void {}

  override dispose(): void {
    this.renderComp?.dispose();
    this.renderComp = null;

    if (this.physicsComp) {
      this.physicsComp.dispose();
      this.physicsComp = null;
    }

    // ── Phase 4: release normal map GPU texture ───────────────────────────
    if (this.normalMapTexture && this.chunkData) {
      const normalMapLabel = `terrain:normal:${this.chunkData.chunkX}_${this.chunkData.chunkZ}`;
      this.normalMapTexture.getTexture()?.destroy();
      ResourceManager.unregisterResource(normalMapLabel);
      this.normalMapTexture = null;
    }

    // ── Splat: release splat map GPU texture ──────────────────────────────
    if (this.splatMapTexture && this.chunkData) {
      const splatLabel = `terrain:splat:${this.chunkData.chunkX}_${this.chunkData.chunkZ}`;
      this.splatMapTexture.getTexture()?.destroy();
      ResourceManager.unregisterResource(splatLabel);
      this.splatMapTexture = null;
    }
  }

  // ---------------------------------------------------------------------------
  // LOD
  // ---------------------------------------------------------------------------

  private checkLOD(): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;
    const camComp = mainCamera.getComponent('camera') as CameraComponent | null;
    if (!camComp) return;

    const camPos = camComp.getCamera().getPosition();
    const cfg = this.chunkData.terrainData.config;

    const centerX = this.chunkData.chunkX * cfg.chunkSize + cfg.chunkSize * 0.5;
    const centerZ = this.chunkData.chunkZ * cfg.chunkSize + cfg.chunkSize * 0.5;

    const dx = (camPos[0] ?? 0) - centerX;
    const dz = (camPos[2] ?? 0) - centerZ;
    const dist2 = dx * dx + dz * dz;

    let targetLod = 3;
    for (let i = 0; i < TerrainChunkComponent.LOD_DIST2.length; i++) {
      if (dist2 < TerrainChunkComponent.LOD_DIST2[i]!) {
        targetLod = i;
        break;
      }
    }

    if (targetLod !== this.currentLodLevel) {
      this.currentLodLevel = targetLod;
      this.buildRenderMesh(targetLod).catch((e) =>
        console.error('[TerrainChunk] LOD rebuild error', e),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Mesh build helpers
  // ---------------------------------------------------------------------------

  /** Builds (or rebuilds) the render mesh at the given LOD. */
  private async buildRenderMesh(lodLevel: number): Promise<void> {
    const rawMesh = TerrainMeshBuilder.build({
      terrainData: this.chunkData.terrainData,
      chunkX: this.chunkData.chunkX,
      chunkZ: this.chunkData.chunkZ,
      lodLevel,
    });

    // ── Phase 4: per-chunk normal map ────────────────────────────────────────
    // Generate a 256×256 tangent-space normal map from the full-res heightmap.
    // The same GPU texture is reused across LOD rebuilds; only the pixel data
    // changes on brush-deform rebuilds.
    const normalMapLabel = `terrain:normal:${this.chunkData.chunkX}_${this.chunkData.chunkZ}`;
    const normalPixels = TerrainNormalMapGenerator.generate(
      this.chunkData.terrainData,
      this.chunkData.chunkX,
      this.chunkData.chunkZ,
    );
    this.normalMapTexture = Texture.createFromPixelData(normalMapLabel, 256, 256, normalPixels);

    // ── Splat: per-chunk splat weight map ─────────────────────────────────────
    // Generate a 256×256 RGBA8 weight texture from heightmap height + slope.
    // R = ground/grass, G = rock, B = snow.
    const splatLabel = `terrain:splat:${this.chunkData.chunkX}_${this.chunkData.chunkZ}`;
    const splatPixels = TerrainSplatGenerator.generate(
      this.chunkData.terrainData,
      this.chunkData.chunkX,
      this.chunkData.chunkZ,
    );
    this.splatMapTexture = Texture.createFromPixelData(splatLabel, 256, 256, splatPixels);

    // Load base material data once (cached after first fetch) so we can
    // create a unique inline material per chunk with the generated textures.
    let baseMat = TerrainChunkComponent.matDataCache.get(this.chunkData.materialPath);
    if (!baseMat) {
      baseMat = await ResourceManager.loadMaterialData(this.chunkData.materialPath);
      TerrainChunkComponent.matDataCache.set(this.chunkData.materialPath, baseMat);
    }

    const perChunkMat: MaterialDataType = {
      ...baseMat,
      textures: {
        ...baseMat.textures,
        // Standard PBR fallback (terrain_test.mat uses txNormal)
        txNormal: normalMapLabel,
        // Splat technique bindings
        txChunkNormal: normalMapLabel,
        txSplat: splatLabel,
      },
    };

    const entity = this.getOwner();

    if (this.renderComp) {
      this.renderComp.dispose();
    }
    this.renderComp = new RenderComponent();
    entity.addComponent('render', this.renderComp);

    await this.renderComp.load({
      meshes: [
        {
          meshData: rawMesh,
          materialData: perChunkMat,
          visible: true,
        },
      ],
    });
  }

  /**
   * Builds (or rebuilds) the physics trimesh collider.
   * Always uses LOD0 so the collision shape is accurate regardless of render LOD.
   * Skirts are excluded from the physics mesh (lodLevel=0, skirtDepth=0).
   */
  private async buildPhysicsCollider(): Promise<void> {
    if (this.chunkData.physics === false) return;

    // Build LOD0 mesh WITHOUT skirts for physics accuracy.
    const rawMesh = TerrainMeshBuilder.build({
      terrainData: this.chunkData.terrainData,
      chunkX: this.chunkData.chunkX,
      chunkZ: this.chunkData.chunkZ,
      lodLevel: 0,
      skirtDepth: 0,
    });

    const entity = this.getOwner();

    // Remove stale collider
    if (this.physicsComp) {
      this.physicsComp.dispose();
      entity.removeComponent?.('mesh_collider');
    }

    this.physicsComp = new MeshColliderComponent();
    entity.addComponent('mesh_collider', this.physicsComp);
    Engine.getEntities().addComponentToManager(this.physicsComp, 'mesh_collider');

    // MeshColliderComponent.load() expects number[] vertices
    const vertices = Array.from(rawMesh.attributes.POSITION);
    const indices = Array.from(rawMesh.indices);

    await this.physicsComp.load({
      vertices,
      indices,
      // Scale is already baked into vertex positions during mesh build.
      ignoreTransformScale: true,
    });
  }

  /** Rebuilds both render mesh (at current LOD) and physics collider. */
  private async rebuildChunk(): Promise<void> {
    this.isRebuilding = true;
    try {
      await Promise.all([this.buildRenderMesh(this.currentLodLevel), this.buildPhysicsCollider()]);
    } finally {
      this.isRebuilding = false;
    }
  }
}
