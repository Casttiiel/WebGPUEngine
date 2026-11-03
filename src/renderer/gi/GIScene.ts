import { mat3, mat4, vec3 } from 'gl-matrix';
import { Logger } from '../../core/debug/Logger';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { RenderKey } from '../core/managers/RenderKeyManager';
import { RenderManagerV2 } from '../core/managers/RenderManagerV2';
import { InstanceManager } from '../core/managers/InstanceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { GPUUtils } from '../core/utils/GPUUtils';
import { Material } from '../resources/Material';
import { Mesh } from '../resources/Mesh';
import { Texture } from '../resources/Texture';
import { TransformComponent } from '../../components/core/TransformComponent';
import { SkeletalMeshComponent } from '../../components/render/SkeletalMeshComponent';
import { SkinnedMesh } from '../resources/SkinnedMesh';
import { BVH_NODE_FLOATS, buildBVH } from './BVHBuilder';
import { GISkinnedBLAS } from './GISkinnedBLAS';
import type { BLASRequest, BLASResponse } from './bvh.worker';

/** Floats per triangle in the GPU buffer (gi/common/bvh.wgsl GITriangle). */
const TRI_FLOATS = 12;
/** Floats per instance (gi/common/bvh.wgsl): invWorld rows ×3, then blasRoot. */
const INSTANCE_FLOATS = 16;
const BLAS_LEAF_SIZE = 4;
/** Instance flag (gi/common/bvh.wgsl GI_INSTANCE_SKINNED). */
const INSTANCE_SKINNED = 1;
/**
 * TLAS box of a character: its bind-pose box, grown to a cube this many times its largest
 * half-extent (the refitted bounds stay on the GPU; any pose must fit).
 */
const SKINNED_BOUNDS_SCALE = 1.5;
/** Albedo for triangles whose material has no texture view yet (linear grey). */
const DEFAULT_ALBEDO = 0xffb4b4b4;
/**
 * Most triangles flattened into the merged static BLAS (world-space copies: an instanced mesh
 * would be duplicated per instance, so only meshes used once are merged anyway).
 */
const MERGE_MAX_TRIS = 2_000_000;

/**
 * A skinned character's own BLAS: built once in the bind pose, re-posed every frame on the GPU
 * (GISkinnedBLAS: skinning + refit, topology fixed).
 */
interface SkinState {
  component: SkeletalMeshComponent;
  mesh: SkinnedMesh;
}

/** A static instance flattened into the merged BLAS (its triangles at firstTri.. of the concatenation). */
interface MergedSource {
  blas: BLASEntry;
  world: mat4;
  transform: TransformComponent;
  key: RenderKey;
  firstTri: number;
}

interface BLASEntry {
  mesh: Mesh;
  material: Material;
  skin?: SkinState;
  /** The merged static BLAS: world-space triangles of these instances (mesh/material unused). */
  merged?: MergedSource[];
  triCount: number;
  nodes: Float32Array;
  order: Uint32Array;
  rootMin: vec3;
  rootMax: vec3;
  // Placement in the merged buffers (set per build)
  nodeOffset: number;
  triOffset: number;
}

interface InstanceEntry {
  blas: BLASEntry;
  world: mat4;
  /**
   * Followed every frame: a moved instance rebuilds the TLAS (rigid dynamic objects). null for
   * the merged static BLAS (identity).
   */
  transform: TransformComponent | null;
  key: RenderKey | null;
}

export interface GISceneStats {
  instances: number;
  blas: number;
  triangles: number;
  nodes: number;
  /** Static instances flattened into the merged BLAS. */
  merged: number;
  buildMs: number;
  boundsMin: number[];
  boundsMax: number[];
}

/**
 * The ray-traceable copy of the static scene: one BLAS per (mesh, material) in object space,
 * a TLAS over the instances, and per-triangle albedo/emissive baked from the material textures
 * at the triangle's UV centroid. Software ray tracing reads it through gi/common/bvh.wgsl.
 *
 * Static level geometry (static shadow casters whose mesh is used once) is flattened into one
 * world-space BLAS: level meshes span whole rooms, so their instance boxes overlap and a short
 * ray used to enter ~9 BLAS from their roots; one BVH over the merged triangles splits space
 * instead. A merged instance that moves is demoted to a TLAS instance (one rebuild).
 *
 * Traceable = SOLIDS that the depth prepass draws, minus alpha-tested geometry (cut-outs would
 * block light). Skinned characters get their own BLAS, re-posed on the GPU every frame
 * (GISkinnedBLAS) and flagged so the probe rays skip them.
 */
export class GIScene {
  private nodesBuffer: GPUBuffer | null = null;
  private trisBuffer: GPUBuffer | null = null;
  private instancesBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private static layout: GPUBindGroupLayout | null = null;

  private blasCache = new Map<Mesh, Map<Material, BLASEntry>>();
  /** Skinned BLAS, one per render key (poses differ per character). */
  private skinnedCache = new Map<number, BLASEntry>();
  private skinnedBLAS = new GISkinnedBLAS();
  /** Current instances (collection order) and the size of the TLAS at the start of the node buffer. */
  private instances: InstanceEntry[] = [];
  private tlasNodeCount = 0;
  private building = false;
  private ready = false;
  private signature = '';
  private stats: GISceneStats | null = null;
  /** Merged static BLAS of the last build, reused while the same instances stay static. */
  private merged: BLASEntry | null = null;
  private mergedSignature = '';
  /** Merged instances that moved: traced as TLAS instances from the next build on. */
  private demoted = new Set<RenderKey>();
  private forceStale = false;

  private bakePipeline: GPUComputePipeline | null = null;
  private bakeLayout: GPUBindGroupLayout | null = null;

  /** group layout shared by every pass that traces: nodes, triangles, instances. */
  public static getLayout(): GPUBindGroupLayout {
    if (!GIScene.layout) {
      const C = GPUShaderStage.COMPUTE;
      GIScene.layout = BindGroupFactory.getLayout('gi_scene_layout', [
        { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      ]);
    }
    return GIScene.layout;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public isBuilding(): boolean {
    return this.building;
  }

  public getBindGroup(): GPUBindGroup | null {
    return this.bindGroup;
  }

  public getStats(): GISceneStats | null {
    return this.stats;
  }

  /** True when the traceable key set changed since the last build (entities added/removed). */
  public isStale(): boolean {
    return !this.building && (this.forceStale || this.computeSignature() !== this.signature);
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  public async build(): Promise<void> {
    if (this.building) return;
    this.building = true;
    const t0 = performance.now();
    try {
      this.forceStale = false;
      const signature = this.computeSignature();
      const instances = this.collectInstances();
      if (instances.length === 0) {
        if (signature !== this.signature) {
          const keys = RenderManagerV2.getInstance().getAllKeys();
          const reasons = new Map<string, number>();
          for (const key of keys) {
            const r = GIScene.rejectReason(key) ?? 'traceable';
            reasons.set(r, (reasons.get(r) ?? 0) + 1);
          }
          Logger.warn('RENDER', `[GI] nothing to trace (${keys.length} keys): ${JSON.stringify([...reasons])}`);
        }
        this.signature = signature;
        return;
      }
      const { traced, merged } = await this.mergeStatic(instances);
      await this.buildMissingBLAS(traced);
      await Promise.all([this.ensureBakePipeline(), this.skinnedBLAS.load()]);
      this.upload(merged ? [...traced, { blas: merged, world: mat4.create(), transform: null, key: null }] : traced);
      this.signature = signature;
      this.ready = true;
      this.stats!.buildMs = performance.now() - t0;
      Logger.info(
        'RENDER',
        `[GI] scene: ${this.stats!.instances} instances (${this.stats!.merged} merged static), ` +
          `${this.stats!.blas} BLAS, ${this.stats!.triangles} tris, ${this.stats!.nodes} nodes, ` +
          `${this.stats!.buildMs.toFixed(0)} ms`,
      );
    } catch (e) {
      console.error('[GI] scene build failed:', e);
    } finally {
      this.building = false;
    }
  }

  private static isTraceable(key: RenderKey): boolean {
    return GIScene.rejectReason(key) === null;
  }

  /** Why a key stays out of the traced scene, or null when it's traceable. */
  private static rejectReason(key: RenderKey): string | null {
    const material = key.material;
    if (material.getCategory() !== RenderCategory.SOLIDS) return `category:${material.getCategory()}`;
    // Vertex-animated (wind grass) and custom-bound draws (particles) aren't static triangles.
    if (key.skipDepthPrepass) return 'custom draw';
    const technique = material.getTechnique();
    if (!technique) return 'no technique';
    if (technique.getIsSkinned()) {
      // Characters: their renderBindGroup is the joint palette; GIScene re-poses them.
      if (!(key.owner instanceof SkeletalMeshComponent) || !(key.mesh instanceof SkinnedMesh)) return 'skinned';
      if (!key.mesh.getJoints() || !key.mesh.getWeights()) return 'skinned (no CPU weights)';
    } else if (key.renderBindGroup) {
      return 'custom draw';
    }
    const name = technique.getName();
    if (name.includes('mask') || name.includes('dither')) return `alpha-tested:${name}`;
    const mesh = key.mesh;
    if (!mesh.isGPUReady() || mesh.getIndexCount() < 3 || !mesh.getVertexPositions()) return 'mesh not ready';
    return null;
  }

  /** Traceable key set, and which of them are static (a key turning movable re-merges). */
  private computeSignature(): string {
    let count = 0;
    let idSum = 0;
    let staticSum = 0;
    for (const key of RenderManagerV2.getInstance().getAllKeys()) {
      if (!GIScene.isTraceable(key)) continue;
      count++;
      idSum = (idSum + key.id * 2654435761) >>> 0;
      if (this.isStatic(key)) staticSum = (staticSum + (key.id + 1) * 2246822519) >>> 0;
    }
    return `${count}:${idSum}:${staticSum}`;
  }

  private isStatic(key: RenderKey): boolean {
    return !this.demoted.has(key) && RenderManagerV2.getInstance().isStaticShadowCaster(key);
  }

  private collectInstances(): InstanceEntry[] {
    const groups = [...InstanceManager.getInstanceGroups().values()];
    const out: InstanceEntry[] = [];
    for (const key of RenderManagerV2.getInstance().getAllKeys()) {
      if (!GIScene.isTraceable(key)) continue;
      const blas = key.owner instanceof SkeletalMeshComponent
        ? this.getOrCreateSkinnedEntry(key)
        : this.getOrCreateBLASEntry(key.mesh, key.material);
      if (key.isInstanced) {
        const group = groups.find((g) => g.instanceBindGroup === key.instanceBindGroup);
        for (const entity of group?.entities ?? []) {
          const transform = entity.getComponent('transform') as TransformComponent | null;
          if (!transform) continue;
          out.push({ blas, world: mat4.clone(transform.getTransform().getWorldMatrix()), transform, key });
        }
      } else {
        const transform = key.transform;
        out.push({ blas, world: mat4.clone(transform.getTransform().getWorldMatrix()), transform, key });
      }
    }
    return out;
  }

  private getOrCreateBLASEntry(mesh: Mesh, material: Material): BLASEntry {
    let byMaterial = this.blasCache.get(mesh);
    if (!byMaterial) {
      byMaterial = new Map();
      this.blasCache.set(mesh, byMaterial);
    }
    let entry = byMaterial.get(material);
    if (!entry) {
      entry = {
        mesh,
        material,
        triCount: Math.floor(mesh.getIndexCount() / 3),
        nodes: new Float32Array(0),
        order: new Uint32Array(0),
        rootMin: vec3.create(),
        rootMax: vec3.create(),
        nodeOffset: 0,
        triOffset: 0,
      };
      byMaterial.set(material, entry);
    }
    return entry;
  }

  private getOrCreateSkinnedEntry(key: RenderKey): BLASEntry {
    let entry = this.skinnedCache.get(key.id);
    if (!entry) {
      const mesh = key.mesh as SkinnedMesh;
      entry = {
        mesh,
        material: key.material,
        skin: { component: key.owner as unknown as SkeletalMeshComponent, mesh },
        triCount: Math.floor(mesh.getIndexCount() / 3),
        nodes: new Float32Array(0),
        order: new Uint32Array(0),
        rootMin: vec3.create(),
        rootMax: vec3.create(),
        nodeOffset: 0,
        triOffset: 0,
      };
      this.skinnedCache.set(key.id, entry);
    }
    return entry;
  }

  /** Builds every BLAS that has no nodes yet on a small worker pool. */
  private async buildMissingBLAS(instances: InstanceEntry[]): Promise<void> {
    const pending = [...new Set(instances.map((i) => i.blas))].filter((b) => b.nodes.length === 0);
    if (pending.length === 0) return;

    // Same geometry with another material shares the BVH: build once per mesh.
    const byMesh = new Map<Mesh, BLASEntry[]>();
    for (const b of pending) {
      const list = byMesh.get(b.mesh) ?? [];
      list.push(b);
      byMesh.set(b.mesh, list);
    }
    const jobs = [...byMesh.entries()];
    const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1, jobs.length));
    const workers = Array.from(
      { length: workerCount },
      () => new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' }),
    );

    let next = 0;
    const runWorker = async (worker: Worker) => {
      while (next < jobs.length) {
        const id = next++;
        const [mesh, entries] = jobs[id]!;
        const positions = new Float32Array(mesh.getVertexPositions());
        const indices = new Uint32Array(mesh.getIndices().subarray(0, mesh.getIndexCount()));
        const response = await GIScene.runBVHJob(worker, { id, positions, indices, maxLeafSize: BLAS_LEAF_SIZE });
        for (const entry of entries) {
          entry.nodes = entry.skin ? response.nodes.slice() : response.nodes;
          entry.order = response.order;
          vec3.set(entry.rootMin, response.nodes[0]!, response.nodes[1]!, response.nodes[2]!);
          vec3.set(entry.rootMax, response.nodes[4]!, response.nodes[5]!, response.nodes[6]!);
        }
      }
    };
    try {
      await Promise.all(workers.map(runWorker));
    } finally {
      workers.forEach((w) => w.terminate());
    }
  }

  /**
   * Splits off the static instances to flatten (static shadow casters whose BLAS no other
   * instance uses) and returns the merged BLAS over them — reused while the set is the same —
   * plus the instances still traced through the TLAS.
   */
  private async mergeStatic(instances: InstanceEntry[]): Promise<{ traced: InstanceEntry[]; merged: BLASEntry | null }> {
    const uses = new Map<BLASEntry, number>();
    for (const inst of instances) uses.set(inst.blas, (uses.get(inst.blas) ?? 0) + 1);
    const candidates = instances.filter(
      (i) => !i.blas.skin && i.key && i.transform && uses.get(i.blas) === 1 && this.isStatic(i.key),
    );
    const triCount = candidates.reduce((sum, i) => sum + i.blas.triCount, 0);
    if (candidates.length < 2 || triCount > MERGE_MAX_TRIS) {
      this.merged = null;
      this.mergedSignature = '';
      return { traced: instances, merged: null };
    }

    const signature = candidates.map((i) => i.key!.id).sort((a, b) => a - b).join(',');
    if (!this.merged || this.mergedSignature !== signature) {
      this.merged = await GIScene.buildMerged(candidates);
      this.mergedSignature = signature;
    }
    const mergedSet = new Set(candidates);
    return { traced: instances.filter((i) => !mergedSet.has(i)), merged: this.merged };
  }

  /** One BVH (worker) over the world-space triangles of `sources`. */
  private static async buildMerged(instances: InstanceEntry[]): Promise<BLASEntry> {
    let vertexCount = 0;
    let indexCount = 0;
    for (const inst of instances) {
      vertexCount += inst.blas.mesh.getVertexPositions().length / 3;
      indexCount += inst.blas.triCount * 3;
    }
    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const sources: MergedSource[] = [];
    const v = vec3.create();
    let vBase = 0;
    let iBase = 0;
    for (const inst of instances) {
      const pos = inst.blas.mesh.getVertexPositions();
      const idx = inst.blas.mesh.getIndices();
      for (let i = 0; i < pos.length; i += 3) {
        vec3.set(v, pos[i]!, pos[i + 1]!, pos[i + 2]!);
        vec3.transformMat4(v, v, inst.world);
        positions.set(v, vBase * 3 + i);
      }
      const n = inst.blas.triCount * 3;
      for (let i = 0; i < n; i++) indices[iBase + i] = idx[i]! + vBase;
      sources.push({ blas: inst.blas, world: inst.world, transform: inst.transform!, key: inst.key!, firstTri: iBase / 3 });
      vBase += pos.length / 3;
      iBase += n;
    }

    const worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
    try {
      const response = await GIScene.runBVHJob(worker, { id: 0, positions, indices, maxLeafSize: BLAS_LEAF_SIZE });
      const first = instances[0]!.blas;
      const nodes = response.nodes;
      return {
        mesh: first.mesh,
        material: first.material,
        merged: sources,
        triCount: indexCount / 3,
        nodes,
        order: response.order,
        rootMin: vec3.fromValues(nodes[0]!, nodes[1]!, nodes[2]!),
        rootMax: vec3.fromValues(nodes[4]!, nodes[5]!, nodes[6]!),
        nodeOffset: 0,
        triOffset: 0,
      };
    } finally {
      worker.terminate();
    }
  }

  private static runBVHJob(worker: Worker, request: BLASRequest): Promise<BLASResponse> {
    return new Promise<BLASResponse>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<BLASResponse>) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage(request, [request.positions.buffer, request.indices.buffer]);
    });
  }

  /** Merges TLAS + BLAS nodes, triangles and instances into GPU buffers, then bakes albedo. */
  private upload(instances: InstanceEntry[]): void {
    // Skinned BLAS last: their triangles form one contiguous range (GISkinnedBLAS).
    const blasList = [...new Set(instances.map((i) => i.blas))].sort((a, b) => Number(!!a.skin) - Number(!!b.skin));
    for (const b of blasList) if (b.skin) GIScene.setSkinnedBounds(b);

    const tlas = GIScene.buildTLAS(instances);
    this.instances = instances;
    this.tlasNodeCount = tlas.nodeCount;

    // ── Placement ─────────────────────────────────────────────────────────
    let nodeCount = tlas.nodeCount;
    let triCount = 0;
    for (const b of blasList) {
      b.nodeOffset = nodeCount;
      b.triOffset = triCount;
      nodeCount += b.nodes.length / BVH_NODE_FLOATS;
      triCount += b.triCount;
    }

    // ── Nodes: TLAS first, then each BLAS with absolute child / triangle indices ──
    const nodes = new Float32Array(nodeCount * BVH_NODE_FLOATS);
    const nodesU = new Uint32Array(nodes.buffer);
    nodes.set(tlas.nodes, 0);
    for (const b of blasList) {
      const base = b.nodeOffset * BVH_NODE_FLOATS;
      nodes.set(b.nodes, base);
      const count = b.nodes.length / BVH_NODE_FLOATS;
      for (let n = 0; n < count; n++) {
        const o = base + n * BVH_NODE_FLOATS;
        nodesU[o + 3]! += nodesU[o + 7] === 0 ? b.nodeOffset : b.triOffset;
      }
    }

    // ── Triangles in leaf order: v0, e1, e2 (object space) + albedo/emissive slots ──
    const tris = new Float32Array(Math.max(1, triCount) * TRI_FLOATS);
    const trisU = new Uint32Array(tris.buffer);
    for (const b of blasList) {
      if (b.merged) {
        // Leaf order spans every source: find each triangle's source by its concatenated index.
        const sourceOf = GIScene.mergedSourceIndex(b);
        const normalMats = b.merged.map((s) => mat3.normalFromMat4(mat3.create(), s.world));
        for (let i = 0; i < b.triCount; i++) {
          const t = b.order[i]!;
          const s = sourceOf[t]!;
          const src = b.merged[s]!;
          GIScene.writeTriangle(tris, trisU, (b.triOffset + i) * TRI_FLOATS, src.blas.mesh, t - src.firstTri, src.world, normalMats[s]!);
        }
      } else {
        for (let i = 0; i < b.triCount; i++) {
          GIScene.writeTriangle(tris, trisU, (b.triOffset + i) * TRI_FLOATS, b.mesh, b.order[i]!, null, null);
        }
      }
    }

    const inst = GIScene.instanceData(instances, tlas.order);

    const skinned = blasList.filter((b) => b.skin);
    for (const [id, entry] of this.skinnedCache) {
      if (!skinned.includes(entry)) this.skinnedCache.delete(id);
    }

    this.destroyBuffers();
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.nodesBuffer = GPUUtils.createBuffer('gi_bvh_nodes', nodes.byteLength, usage, nodes);
    this.trisBuffer = GPUUtils.createBuffer('gi_bvh_tris', tris.byteLength, usage, tris);
    this.instancesBuffer = GPUUtils.createBuffer('gi_bvh_instances', inst.byteLength, usage, inst);
    this.bindGroup = BindGroupFactory.createBindGroup('gi_scene_bg', GIScene.getLayout(), [
      { binding: 0, resource: { buffer: this.nodesBuffer } },
      { binding: 1, resource: { buffer: this.trisBuffer } },
      { binding: 2, resource: { buffer: this.instancesBuffer } },
    ]);

    this.bakeMaterials(blasList);
    this.skinnedBLAS.build(
      skinned.map((b) => ({ ...b.skin!, order: b.order, nodes: b.nodes, triOffset: b.triOffset, triCount: b.triCount, nodeOffset: b.nodeOffset })),
      this.nodesBuffer,
      this.trisBuffer,
    );

    const mergedCount = blasList.reduce((sum, b) => sum + (b.merged?.length ?? 0), 0);
    this.stats = {
      instances: instances.length - (mergedCount > 0 ? 1 : 0) + mergedCount,
      blas: blasList.length,
      triangles: triCount,
      nodes: nodeCount,
      merged: mergedCount,
      buildMs: 0,
      boundsMin: tlas.sceneMin,
      boundsMax: tlas.sceneMax,
    };
  }

  private static readonly triScratch = [vec3.create(), vec3.create(), vec3.create(), vec3.create()];

  /**
   * Triangle `t` of `mesh` at float offset `o`: v0, e1, e2 (object space, or world space with
   * `world`) + albedo / emissive slots (baked later) + the winding flag.
   */
  private static writeTriangle(
    tris: Float32Array,
    trisU: Uint32Array,
    o: number,
    mesh: Mesh,
    t: number,
    world: mat4 | null,
    normalMat: mat3 | null,
  ): void {
    const pos = mesh.getVertexPositions();
    const nrm = mesh.getNormals();
    const idx = mesh.getIndices();
    const ia = idx[t * 3]! * 3, ib = idx[t * 3 + 1]! * 3, ic = idx[t * 3 + 2]! * 3;
    const [a, b, c, n] = GIScene.triScratch as [vec3, vec3, vec3, vec3];
    vec3.set(a, pos[ia]!, pos[ia + 1]!, pos[ia + 2]!);
    vec3.set(b, pos[ib]!, pos[ib + 1]!, pos[ib + 2]!);
    vec3.set(c, pos[ic]!, pos[ic + 1]!, pos[ic + 2]!);
    if (world) {
      vec3.transformMat4(a, a, world);
      vec3.transformMat4(b, b, world);
      vec3.transformMat4(c, c, world);
    }
    vec3.sub(b, b, a);
    vec3.sub(c, c, a);
    tris[o] = a[0]!;
    tris[o + 1] = a[1]!;
    tris[o + 2] = a[2]!;
    trisU[o + 3] = DEFAULT_ALBEDO;
    tris[o + 4] = b[0]!;
    tris[o + 5] = b[1]!;
    tris[o + 6] = b[2]!;
    tris[o + 7] = 0; // emissive
    tris[o + 8] = c[0]!;
    tris[o + 9] = c[1]!;
    tris[o + 10] = c[2]!;
    // Bit 0: the winding disagrees with the vertex normals (front face = vertex-normal side).
    let flip = 0;
    if (nrm && nrm.length === pos.length) {
      vec3.set(
        n,
        nrm[ia]! + nrm[ib]! + nrm[ic]!,
        nrm[ia + 1]! + nrm[ib + 1]! + nrm[ic + 1]!,
        nrm[ia + 2]! + nrm[ib + 2]! + nrm[ic + 2]!,
      );
      if (normalMat) vec3.transformMat3(n, n, normalMat);
      vec3.cross(a, b, c);
      flip = vec3.dot(a, n) < 0 ? 1 : 0;
    }
    trisU[o + 11] = flip;
  }

  /** For the merged BLAS: concatenated triangle index → index of its source. */
  private static mergedSourceIndex(b: BLASEntry): Uint32Array {
    const sourceOf = new Uint32Array(b.triCount);
    b.merged!.forEach((s, i) => sourceOf.fill(i, s.firstTri, s.firstTri + s.blas.triCount));
    return sourceOf;
  }

  /**
   * Rebuilds the TLAS when a traced instance moved this frame (doors, floating orbs, pushed
   * crates). BLAS stay in object space, so only the TLAS nodes and instance rows change; with
   * one instance per leaf the TLAS always has 2n − 1 nodes and is rewritten in place.
   */
  public refreshMovedInstances(): void {
    if (!this.ready || !this.nodesBuffer || !this.instancesBuffer) return;
    let moved = false;
    for (const inst of this.instances) {
      if (!inst.transform) {
        // Merged static BLAS: a source that moves leaves it on the next build.
        for (const s of inst.blas.merged ?? []) {
          if (s.transform.hasMovedThisFrame() && !this.demoted.has(s.key)) {
            this.demoted.add(s.key);
            this.forceStale = true;
          }
        }
        continue;
      }
      if (!inst.transform.hasMovedThisFrame()) continue;
      inst.transform.getTransform().getWorldMatrix(inst.world);
      moved = true;
    }
    if (!moved) return;
    const tlas = GIScene.buildTLAS(this.instances);
    if (tlas.nodeCount !== this.tlasNodeCount) return;
    const queue = GPUUtils.getDevice().queue;
    queue.writeBuffer(this.nodesBuffer, 0, tlas.nodes);
    queue.writeBuffer(this.instancesBuffer, 0, GIScene.instanceData(this.instances, tlas.order));
  }

  /** Re-poses the characters' BLAS to this frame's skeletons (before anything traces). */
  public dispatchSkinning(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (this.ready) this.skinnedBLAS.dispatch(encoder, timestampWrites);
  }

  public hasSkinned(): boolean {
    return this.skinnedBLAS.hasCharacters();
  }

  /** Conservative TLAS box of a skinned BLAS: a cube around its bind-pose box (see SKINNED_BOUNDS_SCALE). */
  private static setSkinnedBounds(b: BLASEntry): void {
    const n = b.nodes;
    let half = 0;
    for (let k = 0; k < 3; k++) half = Math.max(half, (n[4 + k]! - n[k]!) * 0.5);
    half *= SKINNED_BOUNDS_SCALE;
    for (let k = 0; k < 3; k++) {
      const c = (n[k]! + n[4 + k]!) * 0.5;
      b.rootMin[k] = c - half;
      b.rootMax[k] = c + half;
    }
  }

  /** TLAS (one instance per leaf) over the instances' world bounds. */
  private static buildTLAS(instances: InstanceEntry[]) {
    const bounds = new Float32Array(instances.length * 6);
    const corner = vec3.create();
    const sceneMin = [Infinity, Infinity, Infinity];
    const sceneMax = [-Infinity, -Infinity, -Infinity];
    instances.forEach((inst, i) => {
      for (let k = 0; k < 3; k++) {
        bounds[i * 6 + k] = Infinity;
        bounds[i * 6 + 3 + k] = -Infinity;
      }
      for (let c = 0; c < 8; c++) {
        vec3.set(
          corner,
          c & 1 ? inst.blas.rootMax[0] : inst.blas.rootMin[0],
          c & 2 ? inst.blas.rootMax[1] : inst.blas.rootMin[1],
          c & 4 ? inst.blas.rootMax[2] : inst.blas.rootMin[2],
        );
        vec3.transformMat4(corner, corner, inst.world);
        for (let k = 0; k < 3; k++) {
          bounds[i * 6 + k] = Math.min(bounds[i * 6 + k]!, corner[k]!);
          bounds[i * 6 + 3 + k] = Math.max(bounds[i * 6 + 3 + k]!, corner[k]!);
        }
      }
      for (let k = 0; k < 3; k++) {
        sceneMin[k] = Math.min(sceneMin[k]!, bounds[i * 6 + k]!);
        sceneMax[k] = Math.max(sceneMax[k]!, bounds[i * 6 + 3 + k]!);
      }
    });
    const tlas = buildBVH({ bounds, count: instances.length, maxLeafSize: 1, maxSahLeafSize: 1 });
    return { ...tlas, sceneMin, sceneMax };
  }

  /** Instance rows in TLAS leaf order: inverse(world) rows 0–2, then the BLAS root node. */
  private static instanceData(instances: InstanceEntry[], order: Uint32Array): Float32Array {
    const inst = new Float32Array(Math.max(1, instances.length) * INSTANCE_FLOATS);
    const instU = new Uint32Array(inst.buffer);
    const inv = mat4.create();
    for (let i = 0; i < instances.length; i++) {
      const src = instances[order[i]!]!;
      mat4.invert(inv, src.world);
      const o = i * INSTANCE_FLOATS;
      for (let r = 0; r < 3; r++) {
        inst[o + r * 4] = inv[r]!;
        inst[o + r * 4 + 1] = inv[4 + r]!;
        inst[o + r * 4 + 2] = inv[8 + r]!;
        inst[o + r * 4 + 3] = inv[12 + r]!;
      }
      instU[o + 12] = src.blas.nodeOffset;
      instU[o + 13] = src.blas.skin ? INSTANCE_SKINNED : 0;
    }
    return inst;
  }

  // ─── Albedo / emissive bake (texture lookup at each triangle's UV centroid) ──

  private async ensureBakePipeline(): Promise<void> {
    if (this.bakePipeline) return;
    const C = GPUShaderStage.COMPUTE;
    this.bakeLayout = BindGroupFactory.getLayout('gi_bake_layout', [
      { binding: 0, visibility: C, texture: { sampleType: 'float' } }, // albedo
      { binding: 1, visibility: C, texture: { sampleType: 'float' } }, // emissive
      { binding: 2, visibility: C, sampler: { type: 'filtering' } },
      { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } }, // uv + lod per tri
      { binding: 4, visibility: C, buffer: { type: 'storage' } }, // triangles (u32 view)
      { binding: 5, visibility: C, buffer: { type: 'uniform' } },
    ]);
    const code = await ResourceManager.loadShader('gi/gi_bake_albedo.cs');
    this.bakePipeline = PipelineFactory.createComputePipeline({
      label: 'gi_bake_albedo',
      layout: PipelineFactory.createPipelineLayout('gi_bake_albedo_layout', [this.bakeLayout]),
      compute: {
        module: GPUUtils.getDevice().createShaderModule({ label: 'gi_bake_albedo', code }),
        entryPoint: 'cs',
      },
    });
  }

  private bakeMaterials(blasList: BLASEntry[]): void {
    if (!this.bakePipeline || !this.bakeLayout || !this.trisBuffer) return;
    const device = GPUUtils.getDevice();
    const encoder = device.createCommandEncoder({ label: 'gi_bake_albedo' });
    const temp: GPUBuffer[] = [];
    const black = Texture.get('black.png').getTextureView();

    // Per (mesh, material): its triangles (index in the mesh) and where they landed in the buffer.
    const jobs: { mesh: Mesh; material: Material; local: Uint32Array; dest: Uint32Array }[] = [];
    for (const b of blasList) {
      if (!b.merged) {
        const dest = new Uint32Array(b.triCount);
        for (let i = 0; i < b.triCount; i++) dest[i] = b.triOffset + i;
        jobs.push({ mesh: b.mesh, material: b.material, local: b.order, dest });
        continue;
      }
      const sourceOf = GIScene.mergedSourceIndex(b);
      const lists = b.merged.map((s) => ({ s, local: new Uint32Array(s.blas.triCount), dest: new Uint32Array(s.blas.triCount), n: 0 }));
      for (let i = 0; i < b.triCount; i++) {
        const t = b.order[i]!;
        const l = lists[sourceOf[t]!]!;
        l.local[l.n] = t - l.s.firstTri;
        l.dest[l.n++] = b.triOffset + i;
      }
      for (const l of lists) jobs.push({ mesh: l.s.blas.mesh, material: l.s.blas.material, local: l.local, dest: l.dest });
    }

    for (const job of jobs) {
      const albedo = job.material.getSlotTexture('albedo');
      const sampler = albedo?.texture.getSampler();
      // Materials default to black.png emissive (G-buffer emissive = texture.x × factor).
      const emissiveView = job.material.getSlotTexture('emissive')?.view ?? black;
      if (!albedo || !sampler || !emissiveView) continue;

      const count = job.local.length;
      const uvs = job.mesh.getUVs();
      const idx = job.mesh.getIndices();
      const tex = albedo.texture.getTexture();
      const texels = tex ? tex.width * tex.height : 1;
      const sx = job.material.getUvXScale() || 1;
      const sy = job.material.getUvYScale() || 1;
      const uvLod = new Float32Array(count * 4);
      const uvLodU = new Uint32Array(uvLod.buffer);
      for (let i = 0; i < count; i++) {
        const t = job.local[i]!;
        uvLodU[i * 4 + 3] = job.dest[i]!;
        const ia = idx[t * 3]!, ib = idx[t * 3 + 1]!, ic = idx[t * 3 + 2]!;
        let lod = 0;
        if (uvs && uvs.length >= (Math.max(ia, ib, ic) + 1) * 2) {
          const u0 = uvs[ia * 2]! * sx, v0 = uvs[ia * 2 + 1]! * sy;
          const u1 = uvs[ib * 2]! * sx, v1 = uvs[ib * 2 + 1]! * sy;
          const u2 = uvs[ic * 2]! * sx, v2 = uvs[ic * 2 + 1]! * sy;
          uvLod[i * 4] = (u0 + u1 + u2) / 3;
          uvLod[i * 4 + 1] = (v0 + v1 + v2) / 3;
          // Mip whose texel covers the triangle's UV footprint: one tap ≈ the triangle average.
          const uvArea = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) * 0.5;
          lod = Math.max(0, 0.5 * Math.log2(Math.max(uvArea * texels, 1)));
        }
        uvLod[i * 4 + 2] = lod;
      }

      const uvBuffer = GPUUtils.createBuffer(
        'gi_bake_uv',
        uvLod.byteLength,
        GPUBufferUsage.STORAGE,
        uvLod,
      );
      const params = new Float32Array(8);
      const paramsU = new Uint32Array(params.buffer);
      paramsU[0] = 0; // destinations come per triangle (uvLod.w)
      paramsU[1] = count;
      params[2] = job.material.getEmissiveFactor();
      const base = job.material.getBaseColorFactor();
      params[4] = base[0] ?? 1;
      params[5] = base[1] ?? 1;
      params[6] = base[2] ?? 1;
      params[7] = 1;
      const paramsBuffer = GPUUtils.createBuffer(
        'gi_bake_params',
        params.byteLength,
        GPUBufferUsage.UNIFORM,
        params,
      );
      temp.push(uvBuffer, paramsBuffer);

      const bg = BindGroupFactory.createBindGroup('gi_bake_bg', this.bakeLayout, [
        { binding: 0, resource: albedo.view },
        { binding: 1, resource: emissiveView },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: uvBuffer } },
        { binding: 4, resource: { buffer: this.trisBuffer } },
        { binding: 5, resource: { buffer: paramsBuffer } },
      ]);
      const pass = encoder.beginComputePass({ label: 'gi_bake_albedo' });
      pass.setPipeline(this.bakePipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
    device.queue.onSubmittedWorkDone().then(() => temp.forEach((b) => b.destroy()));
  }

  private destroyBuffers(): void {
    this.nodesBuffer?.destroy();
    this.trisBuffer?.destroy();
    this.instancesBuffer?.destroy();
    this.nodesBuffer = this.trisBuffer = this.instancesBuffer = null;
    this.bindGroup = null;
  }

  public destroy(): void {
    this.destroyBuffers();
    this.blasCache.clear();
    this.skinnedCache.clear();
    this.skinnedBLAS.destroy();
    this.merged = null;
    this.mergedSignature = '';
    this.demoted.clear();
    this.instances = [];
    this.ready = false;
    this.signature = '';
  }
}
