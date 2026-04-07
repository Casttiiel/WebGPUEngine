// ---------------------------------------------------------------------------
// WaterVolumeComponent
//
// Implements a tiled water surface using the Compute → DrawIndirect LOD
// pattern:
//
//   Frame N, compute pass 1 (assign_lod):
//     For each patch compute distance to camera → LOD tier (0=coarse,
//     1=medium, 2=fine).  Atomically append the patch descriptor to the
//     appropriate per-LOD instance storage buffer.
//
//   Frame N, compute pass 2 (write_indirect):
//     Copy the 3 atomic counters into a combined 60-byte draw-args buffer
//     (3 × DrawIndexedIndirectParameters) then reset counters to 0.
//
//   CPU (immediately after compute submission):
//     Copy the relevant 20-byte slice of drawArgsBuf into each of the 3
//     per-LOD INDIRECT buffers that RenderManagerV2 will use.
//
//   Render pass (RenderManagerV2):
//     3 drawIndexedIndirect calls — each uses one of the 3 per-LOD meshes
//     and its corresponding INDIRECT buffer.
//
// JSON data example:
//   "water_volume": {
//     "material":     "assets/materials/water.mat",
//     "tilesX":       8,
//     "tilesZ":       8,
//     "patchSize":    10.0,
//     "lodDistances": [20.0, 60.0]
//   }
// ---------------------------------------------------------------------------

import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from '../render/RenderComponent';
import { Mesh } from '../../renderer/resources/Mesh';
import { Material } from '../../renderer/resources/Material';
import { Technique } from '../../renderer/resources/Technique';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { PipelineFactory } from '../../renderer/core/factories/PipelineFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Engine } from '../../core/engine/Engine';

// ────────────────────────────────────────────────────────────────────────────
//  JSON data type
// ────────────────────────────────────────────────────────────────────────────
export interface WaterVolumeComponentData {
  material: string;
  tilesX?: number;
  tilesZ?: number;
  patchSize?: number;
  lodDistances?: [number, number];
}

// ────────────────────────────────────────────────────────────────────────────
//  LOD config: quads per side per tier (low→high detail)
// ────────────────────────────────────────────────────────────────────────────
const LOD_DIVS = [4, 8, 16] as const;

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Generates a flat unit-patch mesh (x ∈ [0,1], z ∈ [0,1], y = 0). */
function buildPatchMesh(divs: number): {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
  indices: Uint32Array;
} {
  const v = (divs + 1) * (divs + 1);
  const positions = new Float32Array(v * 3);
  const normals = new Float32Array(v * 3);
  const uvs = new Float32Array(v * 2);
  const tangents = new Float32Array(v * 4);

  let p = 0,
    n = 0,
    u = 0,
    t = 0;
  for (let iz = 0; iz <= divs; iz++) {
    for (let ix = 0; ix <= divs; ix++) {
      const fx = ix / divs,
        fz = iz / divs;
      positions[p++] = fx;
      positions[p++] = 0;
      positions[p++] = fz;
      normals[n++] = 0;
      normals[n++] = 1;
      normals[n++] = 0;
      uvs[u++] = fx;
      uvs[u++] = fz;
      tangents[t++] = 1;
      tangents[t++] = 0;
      tangents[t++] = 0;
      tangents[t++] = 1;
    }
  }

  const stride = divs + 1;
  const indices = new Uint32Array(divs * divs * 6);
  let k = 0;
  for (let iz = 0; iz < divs; iz++) {
    for (let ix = 0; ix < divs; ix++) {
      const tl = iz * stride + ix;
      const tr = tl + 1,
        bl = tl + stride,
        br = bl + 1;
      indices[k++] = tl;
      indices[k++] = bl;
      indices[k++] = tr;
      indices[k++] = tr;
      indices[k++] = bl;
      indices[k++] = br;
    }
  }
  return { positions, normals, uvs, tangents, indices };
}

// ────────────────────────────────────────────────────────────────────────────
//  Component
// ────────────────────────────────────────────────────────────────────────────
export class WaterVolumeComponent extends Component {
  // Config
  private tilesX = 8;
  private tilesZ = 8;
  private patchSize = 10.0;
  private lodDist0 = 20.0; // near threshold  → LOD 2 (fine) inside
  private lodDist1 = 60.0; // far  threshold  → LOD 0 (coarse) outside

  // ECS
  private transform!: TransformComponent;

  // Assets
  private lodMeshes!: [Mesh, Mesh, Mesh];
  private material!: Material;

  // Per-LOD instance storage buffers (written by compute, read by VS @group(2))
  private instanceBufs!: [GPUBuffer, GPUBuffer, GPUBuffer];
  // Per-LOD instance bind groups (group 2 for VS)
  private instanceBGs!: [GPUBindGroup, GPUBindGroup, GPUBindGroup];
  // Per-LOD indirect draw buffers (INDIRECT | COPY_DST)
  private indirectBufs!: [GPUBuffer, GPUBuffer, GPUBuffer];

  // Compute resources
  private srcPatchesBuf!: GPUBuffer; // static patch descriptors
  private countersBuf!: GPUBuffer; // 3 atomic<u32> counters
  private drawArgsBuf!: GPUBuffer; // 60-byte combined draw-args (3 × DrawArgs)
  private lodParamsBuf!: GPUBuffer; // LodParams uniform

  private assignLodPipeline!: GPUComputePipeline;
  private writeIndirectPipeline!: GPUComputePipeline;
  private computeBG!: GPUBindGroup;
  private computeReady = false;

  // RenderManager owners (one per LOD)
  private renderComps!: [RenderComponent, RenderComponent, RenderComponent];

  private get totalPatches(): number {
    return this.tilesX * this.tilesZ;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public async load(data: WaterVolumeComponentData): Promise<void> {
    this.tilesX = data.tilesX ?? 8;
    this.tilesZ = data.tilesZ ?? 8;
    this.patchSize = data.patchSize ?? 10.0;
    this.lodDist0 = data.lodDistances?.[0] ?? 20.0;
    this.lodDist1 = data.lodDistances?.[1] ?? 60.0;

    // Load the water_volume technique (declares InstanceStorage at group 2)
    await Technique.getAsync('techniques/water/water_volume.tech');

    // Load the material (the component supports any material that uses water.fs)
    this.material = await Material.get(data.material);

    const device = GPUUtils.getDevice();

    this.lodMeshes = await this.createLODMeshes();
    this.createInstanceBuffers(device);
    this.createIndirectBuffers(device);
    this.createComputeBuffers(device);
    await this.buildComputePipelines(device);
    // Compute BG built lazily in update() once camera UBO is ready.
  }

  public override async onAttach(): Promise<void> {
    this.transform = this.getOwner().getComponent('transform') as TransformComponent;

    // Now that transform is available, fill source patch positions
    this.fillSrcPatches();

    // Register render keys
    this.registerRenderKeys();
  }

  public update(_dt: number): void {
    if (!this.assignLodPipeline) return;
    if (!this.computeReady) {
      if (!this.tryBuildComputeBindGroup()) return;
    }
    this.dispatchLODCompute();
  }

  public renderDebug(): void {}

  public override dispose(): void {
    const rm = RenderManagerV2.getInstance();
    for (const rc of this.renderComps ?? []) rm.delKeys(rc);

    this.srcPatchesBuf?.destroy();
    this.countersBuf?.destroy();
    this.drawArgsBuf?.destroy();
    this.lodParamsBuf?.destroy();
    for (const b of this.instanceBufs ?? []) b?.destroy();
    for (const b of this.indirectBufs ?? []) b?.destroy();
  }

  // ── Init helpers ───────────────────────────────────────────────────────────

  private async createLODMeshes(): Promise<[Mesh, Mesh, Mesh]> {
    const meshes = await Promise.all(
      LOD_DIVS.map(async (divs) => {
        const { positions, normals, uvs, tangents, indices } = buildPatchMesh(divs);
        return Mesh.getAsync({
          attributes: {
            POSITION: positions as any,
            NORMAL: normals as any,
            TEXCOORD_0: uvs as any,
            TANGENT: tangents as any,
          },
          indices: indices as any,
        } as any);
      }),
    );
    return meshes as [Mesh, Mesh, Mesh];
  }

  private createInstanceBuffers(device: GPUDevice): void {
    const maxInstances = this.totalPatches;
    const instanceLBGL = device.createBindGroupLayout({
      label: 'water_vol_inst_bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const bufs: GPUBuffer[] = [];
    const bgs: GPUBindGroup[] = [];

    for (let lod = 0; lod < 3; lod++) {
      const buf = device.createBuffer({
        label: `water_lod${lod}_inst`,
        size: Math.max(maxInstances * 16, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      bufs.push(buf);
      bgs.push(
        device.createBindGroup({
          label: `water_lod${lod}_inst_bg`,
          layout: instanceLBGL,
          entries: [{ binding: 0, resource: { buffer: buf } }],
        }),
      );
    }
    this.instanceBufs = bufs as [GPUBuffer, GPUBuffer, GPUBuffer];
    this.instanceBGs = bgs as [GPUBindGroup, GPUBindGroup, GPUBindGroup];
  }

  private createIndirectBuffers(device: GPUDevice): void {
    const bufs: GPUBuffer[] = [];
    for (let lod = 0; lod < 3; lod++) {
      const divs = LOD_DIVS[lod]!;
      const { indices } = buildPatchMesh(divs);
      // DrawIndexedIndirectParameters: indexCount, instanceCount=0, firstIndex=0, baseVertex=0, firstInstance=0
      const init = new Uint32Array([indices.length, 0, 0, 0, 0]);
      const buf = device.createBuffer({
        label: `water_lod${lod}_indirect`,
        size: 20,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, init);
      bufs.push(buf);
    }
    this.indirectBufs = bufs as [GPUBuffer, GPUBuffer, GPUBuffer];
  }

  private createComputeBuffers(device: GPUDevice): void {
    // srcPatches is filled later in fillSrcPatches() once transform is known
    this.srcPatchesBuf = device.createBuffer({
      label: 'water_src_patches',
      size: Math.max(this.totalPatches * 16, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 3 atomic counters + 1 pad = 16 bytes
    this.countersBuf = device.createBuffer({
      label: 'water_counters',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.countersBuf, 0, new Uint32Array([0, 0, 0, 0]));

    // Combined draw-args: 3 × 20 bytes = 60 bytes.
    // write_indirect fills instanceCount; CPU copies slices into indirectBufs.
    this.drawArgsBuf = device.createBuffer({
      label: 'water_drawargs',
      size: 60,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // Initialise indexCounts for each LOD
    const drawArgsInitData = new Uint32Array(15); // 3 × 5 u32
    for (let lod = 0; lod < 3; lod++) {
      const divs = LOD_DIVS[lod]!;
      const { indices } = buildPatchMesh(divs);
      drawArgsInitData[lod * 5 + 0] = indices.length; // indexCount
      drawArgsInitData[lod * 5 + 1] = 0; // instanceCount
      drawArgsInitData[lod * 5 + 2] = 0; // firstIndex
      drawArgsInitData[lod * 5 + 3] = 0; // baseVertex
      drawArgsInitData[lod * 5 + 4] = 0; // firstInstance
    }
    device.queue.writeBuffer(this.drawArgsBuf, 0, drawArgsInitData);

    // LOD params uniform: lodDist0, lodDist1, pad×2
    this.lodParamsBuf = device.createBuffer({
      label: 'water_lod_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.lodParamsBuf,
      0,
      new Float32Array([this.lodDist0, this.lodDist1, 0, 0]),
    );
  }

  private fillSrcPatches(): void {
    const origin = this.transform.getTransform().getWorldPosition();
    const ox = origin[0],
      oz = origin[2];

    const data = new Float32Array(this.totalPatches * 4);
    let i = 0;
    for (let iz = 0; iz < this.tilesZ; iz++) {
      for (let ix = 0; ix < this.tilesX; ix++) {
        data[i++] = ox + ix * this.patchSize; // worldX
        data[i++] = oz + iz * this.patchSize; // worldZ
        data[i++] = this.patchSize; // scale
        data[i++] = 0; // _pad
      }
    }
    GPUUtils.getDevice().queue.writeBuffer(this.srcPatchesBuf, 0, data);
  }

  private async buildComputePipelines(device: GPUDevice): Promise<void> {
    const code = await ResourceManager.loadShader('water/water_lod.cs');
    const module = device.createShaderModule({ label: 'water_lod_cs', code });

    const bgl = device.createBindGroupLayout({
      label: 'water_lod_compute_bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // camera
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // srcPatches
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // counters (atomic)
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // inst0
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // inst1
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // inst2
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // drawArgsBuf (3×DrawArgs)
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // lodParams
      ],
    });
    // Store BGL so tryBuildComputeBindGroup() can use it once camera is ready
    this.computeBGL = bgl;

    const layout = PipelineFactory.createPipelineLayout('water_lod_layout', [bgl]);

    this.assignLodPipeline = PipelineFactory.createComputePipeline({
      label: 'water_lod_assign',
      layout,
      compute: { module, entryPoint: 'assign_lod' },
    });
    this.writeIndirectPipeline = PipelineFactory.createComputePipeline({
      label: 'water_lod_write_indirect',
      layout,
      compute: { module, entryPoint: 'write_indirect' },
    });
  }

  private computeBGL!: GPUBindGroupLayout;

  private tryBuildComputeBindGroup(): boolean {
    const render = Engine.getRender();
    const mainCamera = render?.getMainCamera?.();
    if (!mainCamera) return false;

    const cameraBuf = mainCamera.getUniformBuffer();
    if (!cameraBuf) return false;

    this.computeBG = GPUUtils.getDevice().createBindGroup({
      label: 'water_lod_compute_bg',
      layout: this.computeBGL,
      entries: [
        { binding: 0, resource: { buffer: cameraBuf } }, // CameraUniforms
        { binding: 1, resource: { buffer: this.srcPatchesBuf } },
        { binding: 2, resource: { buffer: this.countersBuf } },
        { binding: 3, resource: { buffer: this.instanceBufs[0] } },
        { binding: 4, resource: { buffer: this.instanceBufs[1] } },
        { binding: 5, resource: { buffer: this.instanceBufs[2] } },
        { binding: 6, resource: { buffer: this.drawArgsBuf } },
        { binding: 7, resource: { buffer: this.lodParamsBuf } },
      ],
    });
    this.computeReady = true;
    return true;
  }

  // ── Per-frame compute + indirect copy ─────────────────────────────────────

  private dispatchLODCompute(): void {
    const device = GPUUtils.getDevice();
    const encoder = device.createCommandEncoder({ label: 'water_lod_compute' });

    // Pass 1: classify patches → append to per-LOD instance buffers
    const p1 = encoder.beginComputePass({ label: 'water_assign_lod' });
    p1.setPipeline(this.assignLodPipeline);
    p1.setBindGroup(0, this.computeBG);
    p1.dispatchWorkgroups(Math.ceil(this.totalPatches / 64));
    p1.end();

    // Pass 2: write atomic counts to drawArgsBuf.instanceCount fields, reset counters
    const p2 = encoder.beginComputePass({ label: 'water_write_indirect' });
    p2.setPipeline(this.writeIndirectPipeline);
    p2.setBindGroup(0, this.computeBG);
    p2.dispatchWorkgroups(1);
    p2.end();

    // Copy per-LOD instanceCount from drawArgsBuf slices → indirectBufs
    // (copyBufferToBuffer transfers GPU→GPU within the same command encoder)
    for (let lod = 0; lod < 3; lod++) {
      encoder.copyBufferToBuffer(
        this.drawArgsBuf,
        lod * 20, // src: combined draw-args slot
        this.indirectBufs[lod]!,
        0, // dst: per-LOD INDIRECT buffer
        20,
      );
    }

    device.queue.submit([encoder.finish()]);
  }

  // ── RenderManager registration ─────────────────────────────────────────────

  private registerRenderKeys(): void {
    const rm = RenderManagerV2.getInstance();

    this.renderComps = [new RenderComponent(), new RenderComponent(), new RenderComponent()];
    for (const rc of this.renderComps) rc.setOwner(this.getOwner());

    for (let lod = 0; lod < 3; lod++) {
      rm.addKey(
        this.renderComps[lod]!,
        this.lodMeshes[lod]!,
        this.material,
        this.transform,
        true, // isInstanced → group 2 = instanceBindGroup
        this.totalPatches, // upper bound (actual count from indirect buffer)
        this.instanceBGs[lod], // @group(2) per-LOD instance storage
        undefined, // renderBindGroup not needed
        this.indirectBufs[lod], // drawIndexedIndirect buffer
      );
    }
  }
}
