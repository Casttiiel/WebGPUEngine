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
import { TerrainComponent } from './TerrainComponent';
import { TerrainData } from '../../core/terrain/TerrainData';
import { GLTFLoader } from '../../core/loaders/GLTFLoader';
import { Wind } from '../../core/engine/Wind';

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
  /** Asset path for the grass material. Default: 'grass_instanced.mat'. */
  material?: string;
  /** Name of the terrain entity to sample heights from. Default: 'Terrain'. */
  terrainName?: string;
  /** Phase 1 wiggle: max chaotic XZ displacement in metres. Default: 0.06. */
  wiggleIntensity?: number;
  /** Phase 1 wiggle: spatial frequency. Default: 1.5. */
  wiggleFrequency?: number;
  /** Phase 2 sway: max directional displacement in metres. Default: 0.12. */
  swayIntensity?: number;
  /** Phase 2 sway: oscillation frequency. Default: 0.8. */
  swayFrequency?: number;
  /** Phase 3 gusts: spatial stripe frequency. Default: 0.25. */
  gustFrequency?: number;
  /** Phase 3 gusts: stripe travel speed. Default: 2.5. */
  gustSpeed?: number;
  /** Phase 3 gusts: amplitude boost at peak (1.0 = no boost). Default: 1.2. */
  gustIntensity?: number;
  /**
   * Path (relative to /assets/textures/) to a greyscale PNG that drives height
   * and colour variation by zone.  White = tall + colourTall tint, black = short
   * + base gradient colour.  Omit to disable zone variation.
   */
  heightMap?: string;
  /** Distance (m) at which the LOD crossfade begins. Near LOD starts fading out,
   *  billboard starts fading in.  Default: 20. */
  lodFadeStart?: number;
  /** Distance (m) at which the near LOD is fully gone and billboard is fully visible.
   *  Default: 28. */
  lodNearFadeEnd?: number;
  /** Distance (m) at which the billboard has completely faded out.  Default: 55. */
  lodFarFadeEnd?: number;
}

// ---------------------------------------------------------------------------
// Per-instance GPU struct (must match GrassInstance in grass_instanced.vs)
// WGSL vec3<f32> has AlignOf=16 but SizeOf=12. The next f32 after it starts
// at byte 12 (not 16) — vec3 alignment only controls where vec3 itself starts.
//   offset  0: pos.x
//   offset  4: pos.y
//   offset  8: pos.z
//   offset 12: seed      ← immediately after the 12-byte vec3
//   offset 16: rotation
//   offset 20: scale
//   offset 24: _pad.x
//   offset 28: _pad.y
//   Total stride: 32 bytes = 8 floats per instance
const FLOATS_PER_INSTANCE = 8; // 32 bytes — matches WGSL array<GrassInstance> stride

export class GrassVolumeComponent extends Component {
  // ── Params ─────────────────────────────────────────────────────────────────
  private width = 50;
  private depth = 50;
  private density = 1.0;
  private maxInstances = 50_000;
  private minScale = 0.6;
  private maxScale = 1.2;
  private materialPath = 'grass_instanced.mat';
  private terrainName = 'Terrain';

  // ── Zone height map ────────────────────────────────────────────────────────
  private heightMap: string | null = null;

  // ── Wind params (loaded from JSON, written to GPU every frame) ─────────────
  private wiggleIntensity = 0.06;
  private wiggleFrequency = 1.5;
  private swayIntensity = 0.12;
  private swayFrequency = 0.8;
  private gustFrequency = 0.25;
  private gustSpeed = 2.5;
  private gustIntensity = 1.2;

  // ── LOD params ─────────────────────────────────────────────────────────────
  private lodFadeStart = 20;
  private lodNearFadeEnd = 28;
  private lodFarFadeEnd = 55;

  // ── GPU resources ──────────────────────────────────────────────────────────
  private instanceBuffer: GPUBuffer | null = null;
  private instanceBindGroup: GPUBindGroup | null = null;
  private indirectDrawBuffer: GPUBuffer | null = null;
  private grassUniformBuffer: GPUBuffer | null = null;
  private grassBindGroup: GPUBindGroup | null = null;

  // ── Billboard LOD GPU resources ────────────────────────────────────────────
  private billboardMesh: Mesh | null = null;
  private billboardIndirectBuffer: GPUBuffer | null = null;
  private billboardRenderComponent: RenderComponent | null = null;

  // ── Render resources ───────────────────────────────────────────────────────
  private grassMesh: Mesh | null = null;
  private grassMaterial: Material | null = null;
  private renderComponent: RenderComponent | null = null;

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
    this.materialPath = d.material ?? 'grass_instanced.mat';
    this.terrainName = d.terrainName ?? 'Terrain';
    this.wiggleIntensity = d.wiggleIntensity ?? 0.06;
    this.wiggleFrequency = d.wiggleFrequency ?? 1.5;
    this.swayIntensity = d.swayIntensity ?? 0.12;
    this.swayFrequency = d.swayFrequency ?? 0.8;
    this.gustFrequency = d.gustFrequency ?? 0.25;
    this.gustSpeed = d.gustSpeed ?? 2.5;
    this.gustIntensity = d.gustIntensity ?? 1.2;
    this.heightMap = d.heightMap ?? null;
    this.lodFadeStart = d.lodFadeStart ?? 20;
    this.lodNearFadeEnd = d.lodNearFadeEnd ?? 28;
    this.lodFarFadeEnd = d.lodFarFadeEnd ?? 55;
  }

  /** Runs after all components on the entity are loaded — terrain is available. */
  override async onAttach(): Promise<void> {
    await this.buildInstances();
  }

  update(_dt: number): void {
    if (!this.grassUniformBuffer) return;
    const device = GPUUtils.getDevice();
    // GrassUniforms layout (56 bytes of data, buffer allocated as 64):
    //   [0]  windDir.x       [1]  windDir.y      [2]  windSpeed
    //   [3]  wiggleIntensity [4]  wiggleFrequency
    //   [5]  swayIntensity   [6]  swayFrequency
    //   [7]  gustFrequency   [8]  gustSpeed       [9]  gustIntensity
    //   [10] lodNearFadeStart [11] lodNearFadeEnd
    //   [12] lodFarFadeStart  [13] lodFarFadeEnd
    //   [14] [15] padding
    const data = new Float32Array(16); // 64 bytes
    data[0] = Wind.getDirX();
    data[1] = Wind.getDirZ();
    data[2] = Wind.speed * 12.0;
    data[3] = this.wiggleIntensity;
    data[4] = this.wiggleFrequency;
    data[5] = this.swayIntensity;
    data[6] = this.swayFrequency;
    data[7] = this.gustFrequency;
    data[8] = this.gustSpeed;
    data[9] = this.gustIntensity;
    data[10] = this.lodFadeStart;
    data[11] = this.lodNearFadeEnd;
    data[12] = this.lodFadeStart; // lodFarFadeStart = same crossfade origin
    data[13] = this.lodFarFadeEnd;
    // data[14], data[15]: padding
    device.queue.writeBuffer(this.grassUniformBuffer, 0, data);
  }
  renderDebug(): void {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (!this.grassMaterial) return;

    const mat = this.grassMaterial;

    /** Converts linear [0,1] floats to a '#rrggbb' hex string for lil-gui. */
    const toHex = (r: number, g: number, b: number): string => {
      const ch = (v: number) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, '0');
      return `#${ch(r)}${ch(g)}${ch(b)}`;
    };

    /** Converts a '#rrggbb' hex string back to linear [0,1] components. */
    const fromHex = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];

    // If a parent entity folder is provided, add a sub-folder inside it.
    // Otherwise fall back to opening a standalone window (legacy/direct use).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let targetFolder: any;
    if (folder) {
      targetFolder = folder.addFolder('Grass Colors');
      targetFolder.close();
    } else {
      const gui = Engine.getGUI();
      if (!gui.getIsVisible()) return;
      if (!gui.beginWindow('Grass Colors', true)) return;
      targetFolder = (gui as any).folders?.get('Grass Colors');
      if (!targetFolder) return;
    }

    // Color Bottom — stored in baseColorFactor.rgb
    const bcf = mat.getBaseColorFactor();
    const bottomObj = { color: toHex(bcf[0] ?? 0, bcf[1] ?? 0, bcf[2] ?? 0) };
    targetFolder
      .addColor(bottomObj, 'color')
      .name('Color Top')
      .onChange((v: string) => {
        const [r, g, b] = fromHex(v);
        mat.setFactors({ baseColorFactor: [r, g, b, 1] });
      });

    // Color Top — repurposed roughnessFactor / metallicFactor / emissiveFactor
    const topObj = {
      color: toHex(mat.getRoughnessFactor(), mat.getMetallicFactor(), mat.getEmissiveFactor()),
    };
    targetFolder
      .addColor(topObj, 'color')
      .name('Color Bottom')
      .onChange((v: string) => {
        const [r, g, b] = fromHex(v);
        mat.setFactors({ roughnessFactor: r, metallicFactor: g, emissiveFactor: b });
      });

    // Color Tall Zones — repurposed uvXScale / uvYScale / pomScale
    const tallObj = { color: toHex(mat.getUvXScale(), mat.getUvYScale(), mat.getPomScale()) };
    targetFolder
      .addColor(tallObj, 'color')
      .name('Color Tall Zones')
      .onChange((v: string) => {
        const [r, g, b] = fromHex(v);
        mat.setFactors({ uvXScale: r, uvYScale: g, pomScale: b });
      });

    // Gradient blend range sliders
    const blendObj = {
      blendStart: mat.getAppearanceBlend(),
      blendEnd: mat.getSurfaceBlend(),
    };
    targetFolder
      .add(blendObj, 'blendStart', 0, 1, 0.01)
      .name('Blend Start')
      .onChange((v: number) => {
        mat.setFactors({ appearanceBlend: v });
      });
    targetFolder
      .add(blendObj, 'blendEnd', 0, 1, 0.01)
      .name('Blend End')
      .onChange((v: number) => {
        mat.setFactors({ surfaceBlend: v });
      });
  }

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
    this.billboardIndirectBuffer?.destroy();
    this.billboardIndirectBuffer = null;
    this.instanceBindGroup = null;
    this.grassUniformBuffer?.destroy();
    this.grassUniformBuffer = null;
    this.grassBindGroup = null;
    // Billboard render key
    if (this.billboardRenderComponent) {
      RenderManagerV2.getInstance().delKeys(this.billboardRenderComponent);
      this.billboardRenderComponent = null;
    }
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

    // Load zone heightmap (optional) — drives per-blade height scale and colour tint
    const heightMapData = this.heightMap ? await this.loadHeightMapData(this.heightMap) : null;

    // Compute instance count
    const area = this.width * this.depth;
    const count = Math.max(1, Math.min(Math.floor(area * this.density), this.maxInstances));

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
      let scale = this.minScale + rand() * (this.maxScale - this.minScale);

      // Zone from heightmap: [0,1] where 1 = tall + colourTall tint, 0 = short + base colour
      let zone = 0.0;
      if (heightMapData) {
        const u = (worldX - (cx - halfW)) / this.width;
        const v = (worldZ - (cz - halfD)) / this.depth;
        zone = this.sampleHeightMap(heightMapData, u, v);
        scale *= 0.35 + zone * 0.65; // lerp(0.35 → 1.0) — short zones get ≈35 % height
      }

      const base = i * FLOATS_PER_INSTANCE;
      instanceData[base + 0] = worldX;
      instanceData[base + 1] = worldY;
      instanceData[base + 2] = worldZ;
      instanceData[base + 3] = seed; // byte 12 — vec3 size=12, so seed is here
      instanceData[base + 4] = rotation; // byte 16
      instanceData[base + 5] = scale; // byte 20
      instanceData[base + 6] = zone; // byte 24 — zone [0,1] passed to FS for colour tint
      instanceData[base + 7] = 0; // byte 28 — padding
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

    // ── Wind + LOD uniform buffer (GrassUniforms at @group(3)) ─────────────────
    this.grassUniformBuffer = device.createBuffer({
      label: 'grass_uniforms_buffer',
      size: 64, // GrassUniforms struct: 14 × f32 (56 bytes) + 8 bytes padding → 64
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const grassUniformLayout = BindGroupFactory.getGrassUniformsLayout();
    this.grassBindGroup = device.createBindGroup({
      label: 'grass_uniforms_bindgroup',
      layout: grassUniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.grassUniformBuffer } }],
    });

    // ── Meshes ────────────────────────────────────────────────────────────────
    [this.grassMesh, this.billboardMesh] = await Promise.all([
      GLTFLoader.loadAsMesh('leaf_uv.gltf'),
      GLTFLoader.loadAsMesh('grass_blade.gltf'),
    ]);

    // ── Indirect draw buffers ─────────────────────────────────────────────────
    // Layout: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    const nearArgs = new Uint32Array([this.grassMesh.getIndexCount(), count, 0, 0, 0]);
    const billboardArgs = new Uint32Array([this.billboardMesh.getIndexCount(), count, 0, 0, 0]);

    this.indirectDrawBuffer = device.createBuffer({
      label: 'grass_indirect_buffer',
      size: nearArgs.byteLength,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indirectDrawBuffer, 0, nearArgs);

    this.billboardIndirectBuffer = device.createBuffer({
      label: 'grass_billboard_indirect_buffer',
      size: billboardArgs.byteLength,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.billboardIndirectBuffer, 0, billboardArgs);

    // ── Material (shared by both LODs) ────────────────────────────────────────
    this.grassMaterial = await Material.get(this.materialPath);

    // ── Register with render manager ──────────────────────────────────────────
    const transformComp = this.getOwner().getComponent('transform') as TransformComponent;

    // Near LOD — detailed leaf mesh with full wind animation
    this.renderComponent = new RenderComponent();
    this.renderComponent.setOwner(this.getOwner());
    RenderManagerV2.getInstance().addKey(
      this.renderComponent,
      this.grassMesh,
      this.grassMaterial,
      transformComp,
      true, // isInstanced
      count,
      this.instanceBindGroup, // @group(2): GrassInstance storage
      this.grassBindGroup, // @group(3): GrassUniforms
      this.indirectDrawBuffer,
      true, // skipDepthPrepass
    );

    // Far LOD — cross-billboard mesh with Bayer fade-in/fade-out
    // Shares the same instanceBindGroup and grassBindGroup (read-only, no conflict).
    this.billboardRenderComponent = new RenderComponent();
    this.billboardRenderComponent.setOwner(this.getOwner());
    // Override the technique to grass_billboard.tech via a billboard-specific material.
    const billboardMaterial = await Material.get('grass_billboard.mat');
    RenderManagerV2.getInstance().addKey(
      this.billboardRenderComponent,
      this.billboardMesh,
      billboardMaterial,
      transformComp,
      true, // isInstanced
      count,
      this.instanceBindGroup, // @group(2): same GrassInstance storage
      this.grassBindGroup, // @group(3): same GrassUniforms
      this.billboardIndirectBuffer,
      true, // skipDepthPrepass
    );
  }

  // ---------------------------------------------------------------------------
  // Height-map zone helpers
  // ---------------------------------------------------------------------------

  /** Loads a greyscale PNG from /assets/textures/<path> and returns its pixel data. */
  private async loadHeightMapData(
    path: string,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
    try {
      const response = await fetch(`/assets/textures/${path}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const imageData = ctx.getImageData(0, 0, width, height);
      return { data: imageData.data, width, height };
    } catch (e) {
      console.warn(`GrassVolumeComponent: could not load heightMap "${path}":`, e);
      return null;
    }
  }

  /** Returns the grass material, or null if buildInstances has not completed yet. */
  public getGrassMaterial(): Material | null {
    return this.grassMaterial;
  }

  /** Samples the red channel of the decoded heightmap at normalised UV [0,1]. */
  private sampleHeightMap(
    hm: { data: Uint8ClampedArray; width: number; height: number },
    u: number,
    v: number,
  ): number {
    const px = Math.min(hm.width - 1, Math.floor(Math.max(0, u) * hm.width));
    const py = Math.min(hm.height - 1, Math.floor(Math.max(0, v) * hm.height));
    return (hm.data[(py * hm.width + px) * 4] ?? 0) / 255;
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
