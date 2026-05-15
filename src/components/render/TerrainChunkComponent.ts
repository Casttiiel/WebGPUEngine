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
   * Hysteresis LOD thresholds (squared distances).
   *
   * INNER = upgrade threshold: switch to a BETTER (lower) LOD when dist² < inner[lod]
   * OUTER = downgrade threshold: switch to a WORSE (higher) LOD when dist² > outer[lod]
   *
   * The dead zone between inner[i] and outer[i] prevents oscillation when the
   * camera sits near a boundary (the previous bug with the 80m single threshold).
   *
   * Values chosen so that the entire 256-unit terrain stays at LOD0 while the
   * camera is anywhere on or near it (~max dist to a chunk centre ≈ 200m).
   */
  private static readonly LOD_INNER_DIST2: [number, number, number] = [
    200 * 200, // < 200m  → upgrade to LOD0
    320 * 320, // < 320m  → upgrade to LOD1
    480 * 480, // < 480m  → upgrade to LOD2
  ];
  private static readonly LOD_OUTER_DIST2: [number, number, number] = [
    225 * 225, // > 225m  → downgrade from LOD0
    360 * 360, // > 360m  → downgrade from LOD1
    540 * 540, // > 540m  → downgrade from LOD2
  ];

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

    const INNER = TerrainChunkComponent.LOD_INNER_DIST2;
    const OUTER = TerrainChunkComponent.LOD_OUTER_DIST2;
    const current = this.currentLodLevel;

    // Resolve the ideal LOD for a given threshold array (no hysteresis, pure distance).
    const idealLod = (thresholds: [number, number, number]): number => {
      for (let i = 0; i < thresholds.length; i++) {
        if (dist2 < thresholds[i]!) return i;
      }
      return 3;
    };

    // Hysteresis: upgrade uses INNER thresholds, downgrade uses OUTER thresholds.
    // In the dead zone (inner < dist < outer for current LOD) the level is kept.
    let targetLod = current;
    const byInner = idealLod(INNER);
    const byOuter = idealLod(OUTER);

    if (byInner < current) targetLod = byInner;       // closer than inner → upgrade
    else if (byOuter > current) targetLod = byOuter;  // farther than outer → downgrade

    if (targetLod !== current) {
      this.currentLodLevel = targetLod;
      this.buildRenderMesh(targetLod).catch((e) =>
        console.error('[TerrainChunk] LOD rebuild error', e),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Mesh build helpers
  // ---------------------------------------------------------------------------

  /**
   * Skirt depth for the render mesh (world units).
   * Skirts hang the border edge vertices downward to hide T-junction cracks
   * that appear when adjacent chunks are at different LOD levels.
   * Keep at 0 for physics collider (always built at LOD0, no T-junctions).
   */
  private static readonly SKIRT_DEPTH = 2.0;

  /**
   * Builds (or rebuilds) the render mesh at the given LOD.
   *
   * @param lodLevel       Target LOD level (0 = full quality).
   * @param rebuildTextures When true the normal map and splat map are
   *   regenerated from the heightmap.  Pass true after brush deformation.
   *   On LOD-only swaps the textures are identical so we skip the CPU work.
   */
  private async buildRenderMesh(lodLevel: number, rebuildTextures = false): Promise<void> {
    const { chunkX, chunkZ } = this.chunkData;
    const normalMapLabel = `terrain:normal:${chunkX}_${chunkZ}`;
    const splatLabel = `terrain:splat:${chunkX}_${chunkZ}`;
    const isFirstBuild = this.renderComp === null;

    // ── Geometry ──────────────────────────────────────────────────────────────
    const rawMesh = TerrainMeshBuilder.build({
      terrainData: this.chunkData.terrainData,
      chunkX,
      chunkZ,
      lodLevel,
      skirtDepth: TerrainChunkComponent.SKIRT_DEPTH,
    });

    // ── Textures ──────────────────────────────────────────────────────────────
    // Normal map and splat map are independent of LOD — skip the (synchronous
    // but expensive) CPU regeneration on LOD-only swaps.
    if (isFirstBuild || rebuildTextures) {
      const normalPixels = TerrainNormalMapGenerator.generate(
        this.chunkData.terrainData,
        chunkX,
        chunkZ,
      );
      this.normalMapTexture = Texture.createFromPixelData(normalMapLabel, 256, 256, normalPixels);

      const splatPixels = TerrainSplatGenerator.generate(
        this.chunkData.terrainData,
        chunkX,
        chunkZ,
      );
      this.splatMapTexture = Texture.createFromPixelData(splatLabel, 256, 256, splatPixels);
    }

    // ── Material (cached base + per-chunk texture overrides) ──────────────────
    let baseMat = TerrainChunkComponent.matDataCache.get(this.chunkData.materialPath);
    if (!baseMat) {
      baseMat = await ResourceManager.loadMaterialData(this.chunkData.materialPath);
      TerrainChunkComponent.matDataCache.set(this.chunkData.materialPath, baseMat);
    }

    const perChunkMat: MaterialDataType = {
      ...baseMat,
      textures: {
        ...baseMat.textures,
        txNormal: normalMapLabel,
        txChunkNormal: normalMapLabel,
        txSplat: splatLabel,
      },
    };

    // ── Flicker-free swap ─────────────────────────────────────────────────────
    // 1. Set owner early so updateRenderManager() inside load() can resolve the
    //    TransformComponent from the entity.
    // 2. Load the new component fully (GPU buffers committed, render keys added).
    //    The OLD component keeps rendering with zero gap during this await.
    // 3. Atomically dispose old + update entity map once new is ready.
    const entity = this.getOwner();
    const oldComp = this.renderComp;

    const newComp = new RenderComponent();
    newComp.setOwner(entity);

    await newComp.load({
      meshes: [{ meshData: rawMesh, materialData: perChunkMat, visible: true }],
    });

    // Atomic swap — old removed from render manager, new already registered.
    oldComp?.dispose();
    entity.addComponent('render', newComp);
    this.renderComp = newComp;
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
      // rebuildTextures=true: heightmap changed via brush, so normal/splat maps must update.
      await Promise.all([
        this.buildRenderMesh(this.currentLodLevel, true),
        this.buildPhysicsCollider(),
      ]);
    } finally {
      this.isRebuilding = false;
    }
  }
}
