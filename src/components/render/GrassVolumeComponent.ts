// ---------------------------------------------------------------------------
// GrassVolumeComponent — instanced grass placement over a box volume
// ---------------------------------------------------------------------------
// Scatters N blade instances inside the owner entity's XZ box footprint,
// snaps each blade's Y to the terrain heightmap, packs per-instance data
// into a GPU storage buffer and registers a single indirect draw call with
// RenderManagerV2.
//
// JSON data shape  (public/assets/scenes/*.json):
// {
//   "grass_volume": {
//     "width":        100,     // full X extent of scatter volume (m)
//     "depth":        100,     // full Z extent of scatter volume (m)
//     "density":      1.0,     // blades per m²
//     "maxInstances": 50000,   // hard cap on total blades
//     "minScale":     0.6,     // minimum blade height scale
//     "maxScale":     1.2,     // maximum blade height scale
//     "material":     "grass.mat",
//     "terrainName":  "Terrain"  // name of terrain entity (optional)
//   }
// }
// ---------------------------------------------------------------------------

import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { RenderComponent } from './RenderComponent';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { GrassMeshBuilder } from '../../core/grass/GrassMeshBuilder';
import { MeshData } from '../../types/MeshData.type';
import { TerrainComponent } from './TerrainComponent';
import { TerrainData } from '../../core/terrain/TerrainData';

// ---------------------------------------------------------------------------
// JSON input shape
// ---------------------------------------------------------------------------
export interface GrassVolumeData {
  /** Full X extent of scatter volume in world units. Default: 50. */
  width?: number;
  /** Full Z extent of scatter volume in world units. Default: 50. */
  depth?: number;
  /** Blades scattered per m². Default: 1.0. */
  density?: number;
  /** Hard cap on the total number of instances. Default: 50 000. */
  maxInstances?: number;
  /** Minimum per-blade height scale. Default: 0.6. */
  minScale?: number;
  /** Maximum per-blade height scale. Default: 1.2. */
  maxScale?: number;
  /** Asset path for the grass material. Default: 'grass.mat'. */
  material?: string;
  /** Name of the terrain entity to sample heights from. Default: 'Terrain'. */
  terrainName?: string;
}

// ---------------------------------------------------------------------------
// Per-instance GPU struct (must match GrassInstance in grass.vs)
// GrassInstance WGSL layout (vec3 has alignment=16 in storage buffers):
//   offset  0: pos.x
//   offset  4: pos.y
//   offset  8: pos.z
//   offset 12: (implicit padding — vec3 stride is 16 in storage)
//   offset 16: seed
//   offset 20: rotation
//   offset 24: scale
//   offset 28: _pad.x
//   offset 32: _pad.y
//   offset 36: (alignment padding to next 16-byte boundary)
//   Total stride: 48 bytes = 12 floats per instance
const FLOATS_PER_INSTANCE = 12; // 48 bytes — matches WGSL array<GrassInstance> stride

export class GrassVolumeComponent extends Component {
  // ── Params ─────────────────────────────────────────────────────────────────
  private width = 50;
  private depth = 50;
  private density = 1.0;
  private maxInstances = 50_000;
  private minScale = 0.6;
  private maxScale = 1.2;
  private materialPath = 'grass.mat';
  private terrainName = 'Terrain';

  // ── GPU resources ──────────────────────────────────────────────────────────
  private instanceBuffer: GPUBuffer | null = null;
  private instanceBindGroup: GPUBindGroup | null = null;
  private indirectDrawBuffer: GPUBuffer | null = null;

  // ── Render resources ───────────────────────────────────────────────────────
  private grassMesh: Mesh | null = null;
  private grassMaterial: Material | null = null;
  private renderComponent: RenderComponent | null = null;

  // ── Instance count (resolved in buildInstances) ────────────────────────────
  private instanceCount = 0;

  // ---------------------------------------------------------------------------
  // Component lifecycle
  // ---------------------------------------------------------------------------

  async load(data: unknown): Promise<void> {
    const d = (data ?? {}) as GrassVolumeData;
    this.width = d.width ?? 50;
    this.depth = d.depth ?? 50;
    this.density = d.density ?? 1.0;
    this.maxInstances = d.maxInstances ?? 50_000;
    this.minScale = d.minScale ?? 0.6;
    this.maxScale = d.maxScale ?? 1.2;
    this.materialPath = d.material ?? 'grass.mat';
    this.terrainName = d.terrainName ?? 'Terrain';
  }

  /** Runs after all components on the entity are loaded — terrain is available. */
  override async onAttach(): Promise<void> {
    await this.buildInstances();
  }

  update(_dt: number): void {}
  renderDebug(): void {}

  override dispose(): void {
    // Remove from render pipeline
    if (this.renderComponent) {
      RenderManagerV2.getInstance().delKeys(this.renderComponent);
      this.renderComponent = null;
    }
    // Destroy GPU buffers
    this.instanceBuffer?.destroy();
    this.instanceBuffer = null;
    this.indirectDrawBuffer?.destroy();
    this.indirectDrawBuffer = null;
    this.instanceBindGroup = null;
  }

  // ---------------------------------------------------------------------------
  // Instance generation
  // ---------------------------------------------------------------------------

  private async buildInstances(): Promise<void> {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    const worldPos = transform?.getTransform().getWorldPosition() ?? [0, 0, 0];
    const cx = worldPos[0] ?? 0;
    const cy = worldPos[1] ?? 0;
    const cz = worldPos[2] ?? 0;

    // Find terrain for height sampling
    const terrainInfo = this.findTerrain();

    // Compute instance count
    const area = this.width * this.depth;
    const count = Math.max(1, Math.min(Math.floor(area * this.density), this.maxInstances));
    this.instanceCount = count;

    // ── Build CPU-side instance data ─────────────────────────────────────────
    const instanceData = new Float32Array(count * FLOATS_PER_INSTANCE);

    // Reproducible scatter via a simple LCG
    let rng = 12345;
    const rand = (): number => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 0xffffffff;
    };

    const halfW = this.width * 0.5;
    const halfD = this.depth * 0.5;

    for (let i = 0; i < count; i++) {
      const localX = (rand() * 2 - 1) * halfW;
      const localZ = (rand() * 2 - 1) * halfD;

      const worldX = cx + localX;
      const worldZ = cz + localZ;

      // Snap Y to terrain height (fallback: volume centre Y)
      let worldY = cy;
      if (terrainInfo) {
        const { td, originX, originY, originZ } = terrainInfo;
        worldY = originY + td.getWorldHeight(worldX - originX, worldZ - originZ);
      }

      const seed = rand();
      const rotation = rand() * Math.PI * 2;
      const scale = this.minScale + rand() * (this.maxScale - this.minScale);

      const base = i * FLOATS_PER_INSTANCE;
      instanceData[base + 0] = worldX;
      instanceData[base + 1] = worldY;
      instanceData[base + 2] = worldZ;
      instanceData[base + 3] = 0;        // vec3 alignment padding (offset 12)
      instanceData[base + 4] = seed;     // offset 16
      instanceData[base + 5] = rotation; // offset 20
      instanceData[base + 6] = scale;    // offset 24
      instanceData[base + 7] = 0;        // _pad.x (offset 28)
      instanceData[base + 8] = 0;        // _pad.y (offset 32)
      instanceData[base + 9]  = 0;       // alignment pad to 48
      instanceData[base + 10] = 0;
      instanceData[base + 11] = 0;
    }

    const device = GPUUtils.getDevice();

    // ── GPU instance storage buffer ──────────────────────────────────────────
    this.instanceBuffer = device.createBuffer({
      label: 'grass_instance_buffer',
      size: instanceData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.instanceBuffer, 0, instanceData);

    // Bind group at @group(2) — uses the standard InstanceStorage layout
    // (single read-only-storage binding 0).  The shader interprets it as
    // array<GrassInstance> rather than array<mat4x4<f32>>.
    const bgLayout = BindGroupFactory.getInstanceStorageLayout();
    this.instanceBindGroup = device.createBindGroup({
      label: 'grass_instance_bindgroup',
      layout: bgLayout,
      entries: [{ binding: 0, resource: { buffer: this.instanceBuffer } }],
    });

    // ── Indirect draw buffer ─────────────────────────────────────────────────
    // Layout: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    const GRASS_INDEX_COUNT = 12; // 2 quads × 2 tris × 3 verts
    const indirectArgs = new Uint32Array([GRASS_INDEX_COUNT, count, 0, 0, 0]);
    this.indirectDrawBuffer = device.createBuffer({
      label: 'grass_indirect_buffer',
      size: indirectArgs.byteLength,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indirectDrawBuffer, 0, indirectArgs);

    // ── Mesh (procedural cross-blade) ─────────────────────────────────────────
    const rawMesh = GrassMeshBuilder.build();
    this.grassMesh = await Mesh.getAsync(rawMesh as unknown as MeshData);

    // ── Material ──────────────────────────────────────────────────────────────
    this.grassMaterial = await Material.get(this.materialPath);

    // ── Register with render manager ──────────────────────────────────────────
    // We need a RenderComponent owner for RenderManagerV2 key management.
    const transformComp = this.getOwner().getComponent('transform') as TransformComponent;

    this.renderComponent = new RenderComponent();
    this.renderComponent.setOwner(this.getOwner());

    RenderManagerV2.getInstance().addKey(
      this.renderComponent,
      this.grassMesh,
      this.grassMaterial,
      transformComp,
      true, // isInstanced — enables instance_index in VS
      count, // instanceCount (informational; indirect buffer controls draw)
      this.instanceBindGroup, // @group(2): GrassInstance storage
      undefined, // renderBindGroup: not used
      this.indirectDrawBuffer, // GPU-driven indirect draw
    );
  }

  // ---------------------------------------------------------------------------
  // Terrain height sampling helper
  // ---------------------------------------------------------------------------

  private findTerrain(): {
    td: TerrainData;
    originX: number;
    originY: number;
    originZ: number;
  } | null {
    const terrainEntity = Engine.getEntities().getEntityByName(this.terrainName);
    if (!terrainEntity) return null;

    const tc = terrainEntity.getComponent('terrain') as TerrainComponent | null;
    if (!tc) return null;

    const tt = terrainEntity.getComponent('transform') as TransformComponent | null;
    const pos = tt?.getTransform().getWorldPosition() ?? [0, 0, 0];

    return {
      td: tc.getTerrainData(),
      originX: pos[0] ?? 0,
      originY: pos[1] ?? 0,
      originZ: pos[2] ?? 0,
    };
  }
}
