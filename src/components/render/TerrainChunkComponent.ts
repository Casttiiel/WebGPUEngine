// ---------------------------------------------------------------------------
// TerrainChunkComponent — one render+physics chunk of the terrain grid
// ---------------------------------------------------------------------------
// Phase 5: MeshCollider (Rapier TRIMESH) at LOD0 for accurate physics.
// Phase 6: Distance-based LOD swap for render mesh only.
// Phase 7: Skirts emitted by TerrainMeshBuilder to hide LOD seams.
// Phase 8: Responds to terrainData dirty flag for brush deformation.
// ---------------------------------------------------------------------------

import { Component } from '../../core/ecs/Component';
import { RenderComponent } from './RenderComponent';
import { TerrainData } from '../../core/terrain/TerrainData';
import { TerrainMeshBuilder } from '../../core/terrain/TerrainMeshBuilder';
import { MeshColliderComponent } from '../physics/MeshColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { CameraComponent } from './CameraComponent';

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
          material: this.chunkData.materialPath,
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
