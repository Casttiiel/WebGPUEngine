// ---------------------------------------------------------------------------
// TerrainComponent — master ECS component that drives the terrain system
// ---------------------------------------------------------------------------
// Placed on a single entity in the scene JSON.  On onAttach() it:
//   1. Generates a heightmap via HeightmapGenerator (or will later load one).
//   2. Creates a grid of chunk child-entities, each with:
//        TransformComponent + TerrainChunkComponent (+ RenderComponent added by chunk).
// ---------------------------------------------------------------------------

import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { HeightmapGenerator, NoiseParams } from '../../core/terrain/HeightmapGenerator';
import { TerrainConfig, TerrainData } from '../../core/terrain/TerrainData';
import { TerrainMeshBuilder } from '../../core/terrain/TerrainMeshBuilder';
import { TerrainChunkComponent } from './TerrainChunkComponent';
import { NavMeshBuilder } from '../../ai/nav/NavMeshBuilder';
import { NavMesh } from '../../ai/nav/NavMesh';

// ---------------------------------------------------------------------------
// JSON data shape (public/assets/scenes/*.json)
// ---------------------------------------------------------------------------
export interface TerrainComponentData {
  totalWidth?: number;
  totalDepth?: number;
  maxHeight?: number;
  chunkSize?: number;
  vertsPerSide?: number;
  /** Asset path for the chunk material during prototyping. */
  material?: string;
  /** Optional noise parameters forwarded to HeightmapGenerator. */
  noise?: NoiseParams;
}

export class TerrainComponent extends Component {
  private terrainData!: TerrainData;
  private materialPath!: string;
  private chunkEntities: Entity[] = [];

  // ── Editable params (bound to GUI, persist across rebuilds) ─────────────
  // Geometry
  public maxHeight: number = 20;
  public vertsPerSide: number = 33;
  // Noise
  public noiseScale: number = 0.005;
  public noiseOctaves: number = 6;
  public noisePersistence: number = 0.5;
  public noiseLacunarity: number = 2.0;
  public noiseSeed: number = 42;

  // ── Brush params (Phase 8) ───────────────────────────────────────────────
  public brushRadius: number = 10;
  public brushStrength: number = 0.005;
  public brushMode: string = 'raise'; // 'raise' | 'lower' | 'smooth' | 'flatten'
  /** Set to true to enable brush painting via ModuleEditorSelection. */
  public brushActive: boolean = false;

  // Stored static config (doesn't change without a full restart)
  private totalWidth: number = 256;
  private totalDepth: number = 256;
  private chunkSize: number = 64;

  // ── Rebuild state ────────────────────────────────────────────────────────
  private rebuildPending: boolean = false;

  // ── Component lifecycle ──────────────────────────────────────────────────

  async load(data: unknown): Promise<void> {
    const d = (data ?? {}) as TerrainComponentData;

    // Resolve config with defaults — store everything for later rebuilds
    this.totalWidth = d.totalWidth ?? 256;
    this.totalDepth = d.totalDepth ?? 256;
    this.maxHeight = d.maxHeight ?? 20;
    this.chunkSize = d.chunkSize ?? 64;
    this.vertsPerSide = d.vertsPerSide ?? 33;
    this.materialPath = d.material ?? 'terrain_test.mat';

    if (d.noise) {
      this.noiseScale = d.noise.scale ?? 0.005;
      this.noiseOctaves = d.noise.octaves ?? 6;
      this.noisePersistence = d.noise.persistence ?? 0.5;
      this.noiseLacunarity = d.noise.lacunarity ?? 2.0;
      this.noiseSeed = d.noise.seed ?? 42;
    }

    this.buildTerrainData();

    // Pre-initialise the recast-navigation WASM module NOW (during loading)
    // so that ensureInit() resolves before gameplay starts, avoiding a
    // ~128ms main-thread block the first time buildNavMesh() is called.
    NavMesh.preloadWasm();
  }

  public override async onAttach(): Promise<void> {
    await this.createChunks();
  }

  update(_dt: number): void {
    if (this.rebuildPending) {
      this.rebuildPending = false;
      this.fullRebuild().catch((e) => console.error('[Terrain] rebuild error', e));
    }
  }

  renderDebug(): void {}

  override dispose(): void {
    this.destroyChunks();
  }

  // ── Brush API (Phase 8) ──────────────────────────────────────────────────

  /**
   * Applies the current brush at a world-space position.
   * Converts to local terrain space, modifies the heightmap, and marks
   * affected chunks dirty so TerrainChunkComponent.update() rebuilds them.
   *
   * @param worldX  World-space X of the brush centre.
   * @param worldZ  World-space Z of the brush centre.
   */
  public applyBrush(worldX: number, worldZ: number): void {
    const tc = this.getOwner().getComponent('transform') as TransformComponent | null;
    const terrainOriginX = tc ? (tc.getTransform().getWorldPosition()[0] ?? 0) : 0;
    const terrainOriginZ = tc ? (tc.getTransform().getWorldPosition()[2] ?? 0) : 0;

    const localX = worldX - terrainOriginX;
    const localZ = worldZ - terrainOriginZ;

    const {
      heightmapWidth,
      heightmapDepth,
      totalWidth,
      totalDepth,
      chunkSize,
      chunkCountX,
      chunkCountZ,
    } = this.terrainData.config;

    // Brush centre in heightmap pixel coordinates
    const cx = (localX / totalWidth) * heightmapWidth;
    const cz = (localZ / totalDepth) * heightmapDepth;

    // Pixel radius
    const rx = (this.brushRadius / totalWidth) * heightmapWidth;
    const rz = (this.brushRadius / totalDepth) * heightmapDepth;

    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(heightmapWidth - 1, Math.ceil(cx + rx));
    const z0 = Math.max(0, Math.floor(cz - rz));
    const z1 = Math.min(heightmapDepth - 1, Math.ceil(cz + rz));

    if (x1 < x0 || z1 < z0) return;

    const r2 = rx * rx; // Use x-axis radius² as a uniform comparison

    // For smooth mode: collect neighbour-average per touched pixel
    const smoothSamples = (px: number, pz: number): number => {
      let sum = 0,
        count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += this.terrainData.getHeightPixel(px + dx, pz + dz);
          count++;
        }
      }
      return sum / count;
    };

    for (let pz = z0; pz <= z1; pz++) {
      for (let px = x0; px <= x1; px++) {
        const ddx = px - cx;
        const ddz = pz - cz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > r2) continue;

        // Smooth cosine falloff
        const t = Math.sqrt(d2 / r2);
        const falloff = 0.5 + 0.5 * Math.cos(Math.PI * t);

        const idx = pz * heightmapWidth + px;
        const current = this.terrainData.heightmap[idx] ?? 0;
        let next = current;

        switch (this.brushMode) {
          case 'raise':
            next = current + this.brushStrength * falloff;
            break;
          case 'lower':
            next = current - this.brushStrength * falloff;
            break;
          case 'smooth':
            next = current + (smoothSamples(px, pz) - current) * this.brushStrength * falloff * 10;
            break;
          case 'flatten': {
            const flatTarget = this.terrainData.getHeightPixel(Math.round(cx), Math.round(cz));
            next = current + (flatTarget - current) * this.brushStrength * falloff * 10;
            break;
          }
        }

        this.terrainData.heightmap[idx] = Math.max(0, Math.min(1, next));
      }
    }

    // Mark affected chunks dirty
    const worldPerPixelX = totalWidth / heightmapWidth;
    const worldPerPixelZ = totalDepth / heightmapDepth;
    const affectRadiusWorld = this.brushRadius + Math.max(worldPerPixelX, worldPerPixelZ);

    const chunkX0 = Math.max(0, Math.floor((localX - affectRadiusWorld) / chunkSize));
    const chunkX1 = Math.min(chunkCountX - 1, Math.floor((localX + affectRadiusWorld) / chunkSize));
    const chunkZ0 = Math.max(0, Math.floor((localZ - affectRadiusWorld) / chunkSize));
    const chunkZ1 = Math.min(chunkCountZ - 1, Math.floor((localZ + affectRadiusWorld) / chunkSize));

    for (let cz2 = chunkZ0; cz2 <= chunkZ1; cz2++) {
      for (let cx2 = chunkX0; cx2 <= chunkX1; cx2++) {
        this.terrainData.markChunkDirty(cx2, cz2);
      }
    }
  }

  /**
   * Adds terrain controls into an entity folder in the Scene panel.
   * Called by ModuleEditorSelection.addEntityToPanel() when a 'terrain' component
   * is detected on the entity.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (folder) this.addToEntityPanel(folder);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public addToEntityPanel(entityFolder: any): void {
    const terrainFolder = entityFolder.addFolder('Terrain');
    terrainFolder.close();

    // ── Geometry ─────────────────────────────────────────────────────────
    const geomFolder = terrainFolder.addFolder('Geometry');
    geomFolder.open();
    geomFolder.add(this, 'maxHeight', 1, 200, 0.5).name('Max Height').listen();
    geomFolder.add(this, 'vertsPerSide', 5, 65, 2).name('Verts / Side').listen();

    // ── Noise ─────────────────────────────────────────────────────────────
    const noiseFolder = terrainFolder.addFolder('Noise');
    noiseFolder.open();
    noiseFolder.add(this, 'noiseScale', 0.0005, 0.05, 0.0001).name('Scale').listen();
    noiseFolder.add(this, 'noiseOctaves', 1, 10, 1).name('Octaves').listen();
    noiseFolder.add(this, 'noisePersistence', 0.1, 0.9, 0.01).name('Persistence').listen();
    noiseFolder.add(this, 'noiseLacunarity', 1.0, 4.0, 0.05).name('Lacunarity').listen();
    noiseFolder.add(this, 'noiseSeed', 0, 9999, 1).name('Seed').listen();

    // ── Actions ───────────────────────────────────────────────────────────
    const actions = {
      rebuild: () => {
        this.rebuildPending = true;
      },
      exportPNG: () => {
        this.terrainData
          .exportHeightmapPNG()
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'terrain_heightmap.png';
            a.click();
            URL.revokeObjectURL(url);
          })
          .catch((e) => console.error('[Terrain] export error', e));
      },
    };

    terrainFolder.add(actions, 'rebuild').name('▶ Apply & Rebuild');
    terrainFolder.add(actions, 'exportPNG').name('⬇ Export Heightmap PNG');

    // ── Brush (Phase 8) ───────────────────────────────────────────────────
    const brushFolder = terrainFolder.addFolder('Brush');
    brushFolder.close();
    brushFolder.add(this, 'brushActive').name('Paint Mode (hold LMB)').listen();
    brushFolder
      .add(this, 'brushMode', ['raise', 'lower', 'smooth', 'flatten'])
      .name('Mode')
      .listen();
    brushFolder.add(this, 'brushRadius', 1, 80, 0.5).name('Radius').listen();
    brushFolder.add(this, 'brushStrength', 0.0005, 0.05, 0.0001).name('Strength').listen();
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  public getTerrainData(): TerrainData {
    return this.terrainData;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Builds the TerrainData from current params (synchronous CPU work). */
  private buildTerrainData(): void {
    const chunkCountX = Math.max(1, Math.round(this.totalWidth / this.chunkSize));
    const chunkCountZ = Math.max(1, Math.round(this.totalDepth / this.chunkSize));
    const heightmapWidth = this.totalWidth;
    const heightmapDepth = this.totalDepth;

    const config: TerrainConfig = {
      totalWidth: this.totalWidth,
      totalDepth: this.totalDepth,
      maxHeight: this.maxHeight,
      chunkSize: this.chunkSize,
      chunkCountX,
      chunkCountZ,
      heightmapWidth,
      heightmapDepth,
      vertsPerSide: Math.max(
        3,
        this.vertsPerSide % 2 === 0 ? this.vertsPerSide + 1 : this.vertsPerSide,
      ),
    };

    const noiseParams: NoiseParams = {
      scale: this.noiseScale,
      octaves: Math.round(this.noiseOctaves),
      persistence: this.noisePersistence,
      lacunarity: this.noiseLacunarity,
      seed: Math.round(this.noiseSeed),
    };

    const heightmap = HeightmapGenerator.generate(heightmapWidth, heightmapDepth, noiseParams);
    this.terrainData = new TerrainData(config, heightmap);
  }

  /** Destroys all chunk entities and clears the array. */
  private destroyChunks(): void {
    for (const entity of this.chunkEntities) {
      Engine.getEntities().destroyEntity(entity);
    }
    this.chunkEntities = [];
  }

  /** Regenerates heightmap + destroys old chunks + spawns new ones. */
  private async fullRebuild(): Promise<void> {
    this.destroyChunks();
    this.buildTerrainData();
    await this.createChunks();
  }

  private async createChunks(): Promise<void> {
    const { chunkCountX, chunkCountZ } = this.terrainData.config;
    const terrainEntity = this.getOwner();

    const chunkPromises: Promise<void>[] = [];
    for (let cx = 0; cx < chunkCountX; cx++) {
      for (let cz = 0; cz < chunkCountZ; cz++) {
        chunkPromises.push(this.createChunk(terrainEntity, cx, cz));
      }
    }
    await Promise.all(chunkPromises);
    // Build navmesh in the background — AI checks isBuilt() before querying,
    // so this is safe to defer. Keeps it off the loading-screen critical path.
    this.buildNavMesh().catch((e) => console.error('[Terrain] NavMesh build failed', e));
  }

  /**
   * Generates a navmesh from the terrain geometry so AI agents can navigate it.
   * Runs TerrainMeshBuilder at LOD 1 (half-resolution) for each chunk,
   * transforms positions to world space, merges all chunks and feeds the
   * combined geometry into NavMeshBuilder (Recast/Detour).
   */
  private async buildNavMesh(): Promise<void> {
    // If the scene already loaded a GLTF navmesh (extras.type === "navmesh" node),
    // skip the terrain build — the scene navmesh covers the actual walkable areas
    // (e.g. sponza building at Y≈0) and the terrain is often underground / outside.
    // Overwriting it would give enemies a navmesh whose polygons are far from them,
    // making every findNearestPoly call dereference a null Detour ptr → freeze.
    if (NavMesh.getInstance().isBuilt()) {
      console.log('[Terrain] Scene navmesh already present — skipping terrain navmesh build.');
      return;
    }

    // LOD 2 = quarter-resolution per chunk. Recast voxelises the mesh anyway
    // so fine input geometry is wasted; LOD 2 still captures all slope features.
    const NAV_LOD = 2;
    const t0 = performance.now();

    const { chunkCountX, chunkCountZ, chunkSize } = this.terrainData.config;

    // Terrain entity world-space origin (may be non-zero if the entity is moved)
    const tc = this.getOwner().getComponent('transform') as TransformComponent | null;
    const originX = tc ? (tc.getTransform().getWorldPosition()[0] ?? 0) : 0;
    const originY = tc ? (tc.getTransform().getWorldPosition()[1] ?? 0) : 0;
    const originZ = tc ? (tc.getTransform().getWorldPosition()[2] ?? 0) : 0;

    const allPositions: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;

    // Yield to the main thread every YIELD_EVERY chunks so the renderer is not
    // blocked for the entire geometry-build loop on large terrain grids.
    const YIELD_EVERY = 4;
    let chunksDone = 0;

    for (let cz = 0; cz < chunkCountZ; cz++) {
      for (let cx = 0; cx < chunkCountX; cx++) {
        const raw = TerrainMeshBuilder.build({
          terrainData: this.terrainData,
          chunkX: cx,
          chunkZ: cz,
          lodLevel: NAV_LOD,
          // No skirts — skirt geometry extends below the surface and
          // would create spurious navmesh polygons underground.
          skirtDepth: 0,
        });

        const pos = raw.attributes.POSITION;
        const vertCount = pos.length / 3;
        const chunkOffsetX = cx * chunkSize + originX;
        const chunkOffsetZ = cz * chunkSize + originZ;

        // Transform chunk-local positions → world space
        for (let i = 0; i < vertCount; i++) {
          allPositions.push((pos[i * 3] ?? 0) + chunkOffsetX);
          allPositions.push((pos[i * 3 + 1] ?? 0) + originY);
          allPositions.push((pos[i * 3 + 2] ?? 0) + chunkOffsetZ);
        }

        for (const idx of raw.indices) {
          allIndices.push(idx + vertexOffset);
        }
        vertexOffset += vertCount;

        chunksDone++;
        if (chunksDone % YIELD_EVERY === 0) {
          // Release the main thread so pending frames and microtasks can run.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    const tGeom = performance.now();
    // Use coarser voxelisation for terrain (cs:1.5, ch:0.3) — the default cs:0.3 on a
    // 256×256 terrain creates ~730 000 voxel cells which can freeze the worker for 30+ s.
    // At cs:1.5 the grid is ~29 000 cells: still ample precision for outdoor AI navigation.
    await NavMeshBuilder.build(
      new Float32Array(allPositions),
      new Uint32Array(allIndices),
      undefined,
      {
        cs: 1.5,
        ch: 0.3,
      },
    );
    console.log(
      `[TerrainComponent] NavMesh built — ${chunkCountX * chunkCountZ} chunks, ` +
        `${allIndices.length / 3} triangles | geom: ${(tGeom - t0).toFixed(1)}ms | ` +
        `total: ${(performance.now() - t0).toFixed(1)}ms`,
    );
  }

  private async createChunk(parent: Entity, cx: number, cz: number): Promise<void> {
    const { chunkSize } = this.terrainData.config;

    const chunkEntity = new Entity();
    parent.addChildren(chunkEntity);
    Engine.getEntities().addEntity(chunkEntity);

    const transform = new TransformComponent();
    chunkEntity.addComponent('transform', transform);
    transform.load({ position: [cx * chunkSize, 0, cz * chunkSize] } as any);
    Engine.getEntities().addComponentToManager(transform, 'transform');

    const chunkComp = new TerrainChunkComponent();
    chunkEntity.addComponent('terrain_chunk', chunkComp);
    await chunkComp.load({
      terrainData: this.terrainData,
      chunkX: cx,
      chunkZ: cz,
      materialPath: this.materialPath,
    });
    Engine.getEntities().addComponentToManager(chunkComp, 'terrain_chunk');

    this.chunkEntities.push(chunkEntity);
  }
}
