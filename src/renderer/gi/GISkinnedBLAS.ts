import { ResourceManager } from '../../core/engine/ResourceManager';
import { SkeletalMeshComponent } from '../../components/render/SkeletalMeshComponent';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SkinnedMesh } from '../resources/SkinnedMesh';
import { BVH_NODE_FLOATS } from './BVHBuilder';

/** Joints per palette slot (SkeletalMeshComponent MAX_JOINTS). */
const PALETTE_JOINTS = 128;
const MAT4_BYTES = 64;
/** Dynamic-offset stride of the per-depth refit ranges (minUniformBufferOffsetAlignment). */
const LEVEL_STRIDE = 256;

/** A skinned BLAS as GIScene placed it in the merged buffers. */
export interface GISkinnedEntry {
  component: SkeletalMeshComponent;
  mesh: SkinnedMesh;
  /** Leaf triangle order of the BLAS build (indexes the mesh's triangles). */
  order: Uint32Array;
  /** The BLAS nodes with local indices (BVHBuilder output). */
  nodes: Float32Array;
  triOffset: number;
  triCount: number;
  nodeOffset: number;
}

/**
 * Keeps the skinned characters' BLAS in GIScene posed like the rasterised characters,
 * entirely on the GPU (docs/realtime-gi-plan.md, phase 6). Per frame:
 *   1. copy every character's joint palette into one buffer
 *   2. gi_skin.cs  — skin each triangle's bind-pose vertices, rewrite its v0 / e1 / e2
 *   3. gi_refit.cs — refit the BLAS bounds, one dispatch per tree depth (deepest first)
 * GIScene places the skinned BLAS last, so their triangles are one contiguous range, and gives
 * the TLAS a conservative box per character (the refitted bounds never come back to the CPU).
 */
export class GISkinnedBLAS {
  private skinPipeline: GPUComputePipeline | null = null;
  private refitPipeline: GPUComputePipeline | null = null;
  private skinLayout: GPUBindGroupLayout;
  private refitLayout: GPUBindGroupLayout;
  private levelLayout: GPUBindGroupLayout;

  private buffers: GPUBuffer[] = [];
  private palettes: GPUBuffer | null = null;
  private skinBindGroup: GPUBindGroup | null = null;
  private refitBindGroup: GPUBindGroup | null = null;
  private levelBindGroup: GPUBindGroup | null = null;
  private characters: SkeletalMeshComponent[] = [];
  private triangleCount = 0;
  /** Nodes per depth, deepest first. */
  private levelCounts: number[] = [];

  constructor() {
    const C = GPUShaderStage.COMPUTE;
    this.skinLayout = BindGroupFactory.getLayout('gi_skin_layout', [
      { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: C, buffer: { type: 'storage' } },
      { binding: 4, visibility: C, buffer: { type: 'uniform' } },
    ]);
    this.refitLayout = BindGroupFactory.getLayout('gi_refit_layout', [
      { binding: 0, visibility: C, buffer: { type: 'storage' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
    ]);
    this.levelLayout = BindGroupFactory.getLayout('gi_refit_level_layout', [
      { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ]);
  }

  public async load(): Promise<void> {
    if (this.skinPipeline) return;
    const device = GPUUtils.getDevice();
    const [skinCode, refitCode] = await Promise.all([
      ResourceManager.loadShader('gi/gi_skin.cs'),
      ResourceManager.loadShader('gi/gi_refit.cs'),
    ]);
    [this.skinPipeline, this.refitPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'gi_skin',
        layout: PipelineFactory.createPipelineLayout('gi_skin_pl', [this.skinLayout]),
        compute: {
          module: device.createShaderModule({ label: 'gi_skin', code: skinCode }),
          entryPoint: 'cs',
        },
      }),
      device.createComputePipelineAsync({
        label: 'gi_refit',
        layout: PipelineFactory.createPipelineLayout('gi_refit_pl', [
          this.refitLayout,
          this.levelLayout,
        ]),
        compute: {
          module: device.createShaderModule({ label: 'gi_refit', code: refitCode }),
          entryPoint: 'cs',
        },
      }),
    ]);
  }

  /**
   * (Re)builds the skinning inputs for the skinned BLAS of a GIScene upload. Their triangles
   * must be contiguous from `entries[0].triOffset` (sorted by triOffset).
   */
  public build(entries: GISkinnedEntry[], nodesBuffer: GPUBuffer, trisBuffer: GPUBuffer): void {
    this.destroyBuffers();
    if (entries.length === 0) return;

    this.characters = [...new Set(entries.map((e) => e.component))];
    const firstTri = entries[0]!.triOffset;
    this.triangleCount = entries.reduce((n, e) => n + e.triCount, 0);

    // Vertices of every entry (a character's copy each), 2 × vec4.
    const vertexBase: number[] = [];
    let vertexCount = 0;
    for (const e of entries) {
      vertexBase.push(vertexCount);
      vertexCount += e.mesh.getVertexPositions().length / 3;
    }
    const vertices = new Float32Array(Math.max(1, vertexCount) * 8);
    const verticesU = new Uint32Array(vertices.buffer);
    entries.forEach((e, k) => {
      const pos = e.mesh.getVertexPositions();
      const joints = e.mesh.getJoints()!;
      const weights = e.mesh.getWeights()!;
      for (let v = 0; v < pos.length / 3; v++) {
        const o = (vertexBase[k]! + v) * 8;
        vertices[o] = pos[v * 3]!;
        vertices[o + 1] = pos[v * 3 + 1]!;
        vertices[o + 2] = pos[v * 3 + 2]!;
        verticesU[o + 3] =
          joints[v * 4]! |
          (joints[v * 4 + 1]! << 8) |
          (joints[v * 4 + 2]! << 16) |
          ((joints[v * 4 + 3]! << 24) >>> 0);
        vertices.set(weights.subarray(v * 4, v * 4 + 4), o + 4);
      }
    });

    // Triangles in the scene's (leaf) order: absolute vertex indices + palette base.
    const triangles = new Uint32Array(Math.max(1, this.triangleCount) * 4);
    entries.forEach((e, k) => {
      const idx = e.mesh.getIndices();
      const base = vertexBase[k]!;
      const palette = this.characters.indexOf(e.component) * PALETTE_JOINTS;
      for (let i = 0; i < e.triCount; i++) {
        const t = e.order[i]!;
        const o = (e.triOffset - firstTri + i) * 4;
        triangles[o] = base + idx[t * 3]!;
        triangles[o + 1] = base + idx[t * 3 + 1]!;
        triangles[o + 2] = base + idx[t * 3 + 2]!;
        triangles[o + 3] = palette;
      }
    });

    // Nodes bucketed by depth (absolute indices), deepest first.
    const byDepth: number[][] = [];
    for (const e of entries) {
      const nodesU = new Uint32Array(e.nodes.buffer, e.nodes.byteOffset, e.nodes.length);
      const stack: [number, number][] = [[0, 0]];
      while (stack.length > 0) {
        const [node, depth] = stack.pop()!;
        (byDepth[depth] ??= []).push(e.nodeOffset + node);
        if (nodesU[node * BVH_NODE_FLOATS + 7] === 0) {
          const left = nodesU[node * BVH_NODE_FLOATS + 3]!;
          stack.push([left, depth + 1], [left + 1, depth + 1]);
        }
      }
    }
    const levels = byDepth.reverse();
    const refitNodes = new Uint32Array(levels.flat());
    this.levelCounts = levels.map((l) => l.length);
    const levelData = new Uint32Array((levels.length * LEVEL_STRIDE) / 4);
    let start = 0;
    levels.forEach((l, i) => {
      levelData[(i * LEVEL_STRIDE) / 4] = start;
      levelData[(i * LEVEL_STRIDE) / 4 + 1] = l.length;
      start += l.length;
    });

    const storage = GPUBufferUsage.STORAGE;
    const vertexBuffer = GPUUtils.createBuffer(
      'gi_skin_vertices',
      vertices.byteLength,
      storage,
      vertices,
    );
    const triangleBuffer = GPUUtils.createBuffer(
      'gi_skin_triangles',
      triangles.byteLength,
      storage,
      triangles,
    );
    const refitBuffer = GPUUtils.createBuffer(
      'gi_refit_nodes',
      refitNodes.byteLength,
      storage,
      refitNodes,
    );
    const levelBuffer = GPUUtils.createBuffer(
      'gi_refit_levels',
      levelData.byteLength,
      GPUBufferUsage.UNIFORM,
      levelData,
    );
    const params = GPUUtils.createBuffer(
      'gi_skin_params',
      16,
      GPUBufferUsage.UNIFORM,
      new Uint32Array([firstTri, this.triangleCount, 0, 0]),
    );
    this.palettes = GPUUtils.createBuffer(
      'gi_skin_palettes',
      this.characters.length * PALETTE_JOINTS * MAT4_BYTES,
      storage | GPUBufferUsage.COPY_DST,
    );
    this.buffers = [vertexBuffer, triangleBuffer, refitBuffer, levelBuffer, params, this.palettes];

    this.skinBindGroup = BindGroupFactory.createBindGroup('gi_skin_bg', this.skinLayout, [
      { binding: 0, resource: { buffer: vertexBuffer } },
      { binding: 1, resource: { buffer: triangleBuffer } },
      { binding: 2, resource: { buffer: this.palettes } },
      { binding: 3, resource: { buffer: trisBuffer } },
      { binding: 4, resource: { buffer: params } },
    ]);
    this.refitBindGroup = BindGroupFactory.createBindGroup('gi_refit_bg', this.refitLayout, [
      { binding: 0, resource: { buffer: nodesBuffer } },
      { binding: 1, resource: { buffer: trisBuffer } },
      { binding: 2, resource: { buffer: refitBuffer } },
    ]);
    this.levelBindGroup = BindGroupFactory.createBindGroup('gi_refit_level_bg', this.levelLayout, [
      { binding: 0, resource: { buffer: levelBuffer, size: 16 } },
    ]);
  }

  /** Copies this frame's poses and re-poses every skinned BLAS. */
  public dispatch(
    encoder: GPUCommandEncoder,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    if (!this.skinPipeline || !this.refitPipeline || !this.skinBindGroup || !this.palettes) return;
    this.characters.forEach((character, i) => {
      const palette = character.getJointMatrixBuffer();
      if (!palette) return; // disposed: keeps its last pose until GIScene drops it
      const bytes = Math.min(character.asset.skeleton.joints.length, PALETTE_JOINTS) * MAT4_BYTES;
      encoder.copyBufferToBuffer(
        palette,
        0,
        this.palettes!,
        i * PALETTE_JOINTS * MAT4_BYTES,
        bytes,
      );
    });

    const pass = encoder.beginComputePass({
      label: 'GI Skin',
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(this.skinPipeline);
    pass.setBindGroup(0, this.skinBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.triangleCount / 64));
    pass.setPipeline(this.refitPipeline);
    pass.setBindGroup(0, this.refitBindGroup!);
    this.levelCounts.forEach((count, i) => {
      pass.setBindGroup(1, this.levelBindGroup!, [i * LEVEL_STRIDE]);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
    });
    pass.end();
  }

  public hasCharacters(): boolean {
    return this.characters.length > 0;
  }

  private destroyBuffers(): void {
    this.buffers.forEach((b) => b.destroy());
    this.buffers = [];
    this.palettes = null;
    this.skinBindGroup = null;
    this.refitBindGroup = null;
    this.levelBindGroup = null;
    this.characters = [];
    this.triangleCount = 0;
    this.levelCounts = [];
  }

  public destroy(): void {
    this.destroyBuffers();
  }
}
