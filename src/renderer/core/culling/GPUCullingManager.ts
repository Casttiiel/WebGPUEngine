import { Camera } from '../../../core/math/Camera';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { GPUUtils } from '../utils/GPUUtils';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory } from '../factories/PipelineFactory';
import { RenderKey } from '../managers/RenderKeyManager';
import { mat4 } from 'gl-matrix';

// ---------------------------------------------------------------------------
// Layout constants (must match frustum_culling_indirect.cs)
// ---------------------------------------------------------------------------

/** Bytes per ObjectData entry on the GPU (128 bytes, 16-byte aligned). */
const OBJECT_STRIDE = 128;

/**
 * Bytes per DrawIndexedIndirectParameters entry (5 × u32/i32 = 20 bytes).
 * Must match the WebGPU drawIndexedIndirect spec layout.
 */
const INDIRECT_STRIDE = 20;

/** Size of the FrustumPlanes uniform (6 planes × vec4<f32> = 96 bytes). */
const FRUSTUM_SIZE = 96;

/**
 * Maximum concurrent shadow dispatches per frame
 * (e.g. 3 cascades + 6×point-face + 2 spotlights = 11; 20 gives comfortable headroom).
 */
const SHADOW_POOL = 20;

// ObjectData memory map (byte offsets):
//   [  0.. 31]  AABB  (min.xyz + pad + max.xyz + pad)
//   [ 32.. 95]  modelMatrix (mat4x4<f32>, 16 floats)
//   [ 96..115]  draw args:  indexCount, instanceCount, firstIndex, baseVertex, firstInstance
//   [116..127]  _pad[3]

/**
 * GPU-driven frustum culling.
 *
 * Replaces per-frame CPU AABB testing for main-camera draw calls.
 * The compute shader writes DrawIndexedIndirectParameters directly —
 * culled objects get instanceCount = 0 so the GPU skips them silently.
 *
 * Shadow cameras keep using CPUCullingManager (separate frustum per light,
 * simpler to handle without a second GPU dispatch per shadow).
 *
 * Usage (inside RenderManagerV2):
 *   1. await gpuCuller.initialize()          — once at startup
 *   2. gpuCuller.rebuild(allKeys)            — whenever keys change
 *   3. gpuCuller.dispatch(encoder, camera)   — once per frame before render passes
 */
export class GPUCullingManager {
  private device!: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // GPU buffers
  private objectDataBuffer!: GPUBuffer; // N × OBJECT_STRIDE
  private frustumBuffer!: GPUBuffer; // FRUSTUM_SIZE bytes
  private indirectArgsBuffer!: GPUBuffer; // N × INDIRECT_STRIDE

  private bindGroup!: GPUBindGroup;

  // CPU-side staging (shared ArrayBuffer, different typed views)
  private cpuObjectData = new ArrayBuffer(0);
  private cpuF32 = new Float32Array(0);
  private cpuU32 = new Uint32Array(0);

  private cpuFrustum = new Float32Array(24); // 6 planes × 4 floats
  private viewProj = mat4.create();

  // Keys we are culling (excludes shadows, instanced groups, particles)
  private managedKeys: RenderKey[] = [];
  private capacity = 0;

  private built = false;
  private initialized = false;

  // ---- Shadow culling pool ----
  // One shared objectDataBuffer for shadow-cast keys (AABB + draw args, static).
  // A pool of SHADOW_POOL indirect + frustum buffers so each per-light dispatch
  // writes to its own slot — all submitted into the same GPUCommandEncoder.
  private shadowKeys: RenderKey[] = [];
  private shadowCapacity = 0;
  private shadowObjectDataBuffer!: GPUBuffer;
  private shadowIndirectPool: GPUBuffer[] = [];
  private shadowFrustumPool: GPUBuffer[] = [];
  private shadowBindGroupPool: GPUBindGroup[] = [];
  private shadowSlotIndex = 0;
  private shadowBuilt = false;
  private shadowMatricesDirty = true;

  // CPU staging for shadow object data (separate from main to avoid aliasing)
  private cpuShadowObjectData = new ArrayBuffer(0);
  private cpuShadowF32 = new Float32Array(0);
  private cpuShadowU32 = new Uint32Array(0);
  private cpuShadowFrustum = new Float32Array(24);

  // ------------------------------------------------------------------
  // Initialization
  // ------------------------------------------------------------------

  public async initialize(): Promise<void> {
    this.device = GPUUtils.getDevice();

    const shaderCode = await ResourceManager.loadShader('utility/frustum_culling_indirect.cs');

    // Bind group layout: frustum uniform | object data storage-r | indirect args storage-rw
    this.bindGroupLayout = BindGroupFactory.getLayout('gpu_culling_indirect_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ]);

    const shaderModule = this.device.createShaderModule({
      label: 'gpu_frustum_culling_indirect_shader',
      code: shaderCode,
    });

    const pipelineLayout = PipelineFactory.createPipelineLayout('gpu_culling_indirect_layout', [
      this.bindGroupLayout,
    ]);

    this.pipeline = this.device.createComputePipeline({
      label: 'gpu_frustum_culling_indirect_pipeline',
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    // Persistent frustum uniform buffer
    this.frustumBuffer = this.device.createBuffer({
      label: 'gpu_culling_frustum',
      size: FRUSTUM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  // ------------------------------------------------------------------
  // Rebuild (called when the key list changes)
  // ------------------------------------------------------------------

  /**
   * Rebuilds GPU buffers and assigns indirectDrawBuffer / indirectDrawOffset
   * on each managed key.  Keyed on:
   *   - not instanced (instanced groups always pass through)
   *   - not a shadow category key
   *   - no custom renderBindGroup (= not a particle / special draw)
   */
  public rebuild(allKeys: RenderKey[]): void {
    // Release previous assignments
    for (const key of this.managedKeys) {
      key.indirectDrawBuffer = undefined;
      key.indirectDrawOffset = 0;
    }

    // Filter to cullable keys
    this.managedKeys = allKeys.filter(
      (key) =>
        !key.isInstanced && // instanced groups: always visible (multi-AABB would be needed)
        key.material.getCategory() !== RenderCategory.SHADOWS && // shadow keys use CPU culling
        !key.renderBindGroup, // particles / custom indirect already own their buffer
    );

    const n = this.managedKeys.length;
    if (n === 0) {
      this.built = true;
      return;
    }

    // Grow GPU buffers if needed
    if (n > this.capacity) {
      this.objectDataBuffer?.destroy();
      this.indirectArgsBuffer?.destroy();

      this.objectDataBuffer = this.device.createBuffer({
        label: 'gpu_culling_object_data',
        size: n * OBJECT_STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      this.indirectArgsBuffer = this.device.createBuffer({
        label: 'gpu_culling_indirect_args',
        // STORAGE so the compute shader can write to it;
        // INDIRECT so drawIndexedIndirect can read from it.
        size: n * INDIRECT_STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });

      this.capacity = n;

      // Matching CPU staging buffers (shared ArrayBuffer for zero-copy views)
      this.cpuObjectData = new ArrayBuffer(n * OBJECT_STRIDE);
      this.cpuF32 = new Float32Array(this.cpuObjectData);
      this.cpuU32 = new Uint32Array(this.cpuObjectData);
    }

    // New bind group referencing (possibly new) buffers
    this.bindGroup = this.device.createBindGroup({
      label: 'gpu_culling_bind_group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frustumBuffer } },
        { binding: 1, resource: { buffer: this.objectDataBuffer, size: n * OBJECT_STRIDE } },
        { binding: 2, resource: { buffer: this.indirectArgsBuffer, size: n * INDIRECT_STRIDE } },
      ],
    });

    // Assign each managed key its slot in the shared indirect buffer
    for (let i = 0; i < n; i++) {
      const key = this.managedKeys[i]!;
      key.indirectDrawBuffer = this.indirectArgsBuffer;
      key.indirectDrawOffset = i * INDIRECT_STRIDE;
    }

    // Write static parts (AABB + draw args) — only changes on rebuild
    this.writeStaticObjectData(n);

    this.built = true;

    // Also rebuild the shadow culling pool from the SHADOWS-category keys
    const shadowKeys = allKeys.filter(
      (key) => key.material.getCategory() === RenderCategory.SHADOWS && !key.isInstanced,
    );
    this.rebuildShadow(shadowKeys);
  }

  public isDirty(): boolean {
    return !this.built;
  }

  public markDirty(): void {
    this.built = false;
    this.shadowBuilt = false;
  }

  // ------------------------------------------------------------------
  // Shadow culling pool
  // ------------------------------------------------------------------

  /**
   * Rebuilds the shadow object-data buffer and the per-dispatch indirect pool.
   * Called automatically from rebuild() whenever the full key list changes.
   */
  private rebuildShadow(newShadowKeys: RenderKey[]): void {
    // Clear previous assignments
    for (const key of this.shadowKeys) {
      key.shadowIndirectOffset = -1;
    }

    this.shadowKeys = newShadowKeys;
    const n = this.shadowKeys.length;

    if (n === 0) {
      this.shadowBuilt = true;
      return;
    }

    // Grow shared shadow object-data buffer if needed
    if (n > this.shadowCapacity) {
      this.shadowObjectDataBuffer?.destroy();
      this.shadowObjectDataBuffer = this.device.createBuffer({
        label: 'gpu_culling_shadow_object_data',
        size: n * OBJECT_STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.shadowCapacity = n;

      this.cpuShadowObjectData = new ArrayBuffer(n * OBJECT_STRIDE);
      this.cpuShadowF32 = new Float32Array(this.cpuShadowObjectData);
      this.cpuShadowU32 = new Uint32Array(this.cpuShadowObjectData);
    }

    // Grow pool if needed (SHADOW_POOL slots, each has its own indirect + frustum + bind group)
    if (this.shadowIndirectPool.length < SHADOW_POOL) {
      // Destroy any existing pool buffers
      for (const buf of this.shadowIndirectPool) buf.destroy();
      for (const buf of this.shadowFrustumPool) buf.destroy();
      this.shadowIndirectPool = [];
      this.shadowFrustumPool = [];
      this.shadowBindGroupPool = [];

      for (let s = 0; s < SHADOW_POOL; s++) {
        const indirect = this.device.createBuffer({
          label: `gpu_culling_shadow_indirect_slot${s}`,
          size: n * INDIRECT_STRIDE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        const frustum = this.device.createBuffer({
          label: `gpu_culling_shadow_frustum_slot${s}`,
          size: FRUSTUM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bg = this.device.createBindGroup({
          label: `gpu_culling_shadow_bind_group_slot${s}`,
          layout: this.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: frustum } },
            {
              binding: 1,
              resource: { buffer: this.shadowObjectDataBuffer, size: n * OBJECT_STRIDE },
            },
            { binding: 2, resource: { buffer: indirect, size: n * INDIRECT_STRIDE } },
          ],
        });
        this.shadowIndirectPool.push(indirect);
        this.shadowFrustumPool.push(frustum);
        this.shadowBindGroupPool.push(bg);
      }
    } else if (n * INDIRECT_STRIDE > this.shadowIndirectPool[0]!.size) {
      // More shadow keys than before — grow all pool indirect buffers
      for (let s = 0; s < SHADOW_POOL; s++) {
        this.shadowIndirectPool[s]!.destroy();
        this.shadowIndirectPool[s] = this.device.createBuffer({
          label: `gpu_culling_shadow_indirect_slot${s}`,
          size: n * INDIRECT_STRIDE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        // Rebuild bind group to reference new indirect buffer
        this.shadowBindGroupPool[s] = this.device.createBindGroup({
          label: `gpu_culling_shadow_bind_group_slot${s}`,
          layout: this.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.shadowFrustumPool[s]! } },
            {
              binding: 1,
              resource: { buffer: this.shadowObjectDataBuffer, size: n * OBJECT_STRIDE },
            },
            {
              binding: 2,
              resource: { buffer: this.shadowIndirectPool[s]!, size: n * INDIRECT_STRIDE },
            },
          ],
        });
      }
    }

    // Assign shadowIndirectOffset on each key (same offset regardless of slot —
    // all slots have the same layout, only the frustum differs)
    for (let i = 0; i < n; i++) {
      this.shadowKeys[i]!.shadowIndirectOffset = i * INDIRECT_STRIDE;
    }

    // Write static fields (AABB + draw args)
    this.writeShadowStaticData(n);

    this.shadowBuilt = true;
    this.shadowMatricesDirty = true;
  }

  /** Returns true when the shadow pool is ready for dispatchShadow() calls. */
  public isShadowReady(): boolean {
    return this.shadowBuilt && this.shadowKeys.length > 0;
  }

  /**
   * Dispatches the frustum culling compute shader for one shadow camera.
   * Uses a rotating slot from the pool so concurrent calls within the same
   * command encoder each write to their own indirect buffer.
   *
   * @returns The indirect buffer for this slot — pass it to renderKeys via
   *          RenderManagerV2.currentShadowIndirectBuffer.
   */
  public dispatchShadow(commandEncoder: GPUCommandEncoder, camera: Camera): GPUBuffer {
    const n = this.shadowKeys.length;
    const slot = this.shadowSlotIndex % SHADOW_POOL;
    this.shadowSlotIndex++;

    // Write shadow model matrices once per frame (same world matrices for all cameras)
    if (this.shadowMatricesDirty) {
      this.writeShadowModelMatrices(n);
      this.device.queue.writeBuffer(
        this.shadowObjectDataBuffer,
        0,
        this.cpuShadowObjectData,
        0,
        n * OBJECT_STRIDE,
      );
      this.shadowMatricesDirty = false;
    }

    // Update frustum uniform for this camera into the slot's frustum buffer
    this.extractFrustumPlanesTo(camera, this.cpuShadowFrustum);
    this.device.queue.writeBuffer(this.shadowFrustumPool[slot]!, 0, this.cpuShadowFrustum);

    // Dispatch
    const computePass = commandEncoder.beginComputePass({
      label: `gpu_shadow_culling_slot${slot}`,
    });
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.shadowBindGroupPool[slot]!);
    computePass.dispatchWorkgroups(Math.ceil(n / 64));
    computePass.end();

    return this.shadowIndirectPool[slot]!;
  }

  // ------------------------------------------------------------------
  // Per-frame dispatch
  // ------------------------------------------------------------------

  /**
   * Updates model matrices + frustum uniform, then dispatches the compute shader.
   * Must be called on the current frame's command encoder BEFORE render passes.
   */
  public dispatch(commandEncoder: GPUCommandEncoder, camera: Camera): void {
    if (!this.built || this.managedKeys.length === 0) return;

    const n = this.managedKeys.length;

    // Reset shadow slot index and mark shadow matrices dirty each new frame
    this.shadowSlotIndex = 0;
    this.shadowMatricesDirty = true;

    // 1. Update frustum uniform (96 bytes, cheap)
    this.extractFrustumPlanesTo(camera, this.cpuFrustum);
    this.device.queue.writeBuffer(this.frustumBuffer, 0, this.cpuFrustum);

    // 2. Update model matrices in the ObjectData staging buffer.
    //    Model matrix occupies bytes [32..95] per entry (float32 indices [8..23]).
    this.writeModelMatrices(n);
    this.device.queue.writeBuffer(
      this.objectDataBuffer,
      0,
      this.cpuObjectData,
      0,
      n * OBJECT_STRIDE,
    );

    // 3. Compute pass — 64 threads per workgroup
    const computePass = commandEncoder.beginComputePass({ label: 'gpu_frustum_culling_indirect' });
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(n / 64));
    computePass.end();
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Writes AABB (local space) and draw-arg fields.
   * These are static an only need re-writing on rebuild.
   */
  private writeStaticObjectData(n: number): void {
    const f32 = this.cpuF32;
    const u32 = this.cpuU32;

    for (let i = 0; i < n; i++) {
      const key = this.managedKeys[i]!;
      const b = (i * OBJECT_STRIDE) / 4; // base index into Float32/Uint32 array

      // AABB (local / model space) — byte offsets 0–31, float32 indices b+0..b+7
      const aabb = key.aabb;
      if (aabb) {
        f32[b + 0] = aabb.min[0] ?? 0;
        f32[b + 1] = aabb.min[1] ?? 0;
        f32[b + 2] = aabb.min[2] ?? 0;
        f32[b + 3] = 0; // _pad1
        f32[b + 4] = aabb.max[0] ?? 0;
        f32[b + 5] = aabb.max[1] ?? 0;
        f32[b + 6] = aabb.max[2] ?? 0;
        f32[b + 7] = 0; // _pad2
      }
      // modelMatrix will be written per-frame in writeModelMatrices (b+8..b+23)

      // Draw args — byte offset 96 = float32 index b+24
      u32[b + 24] = key.mesh.getIndexCount();
      u32[b + 25] = key.instanceCount; // 1 for regular objects
      u32[b + 26] = 0; // firstIndex
      u32[b + 27] = 0; // baseVertex (i32, 0 casts fine as u32)
      u32[b + 28] = 0; // firstInstance
      // _pad[3] (indices b+29, b+30, b+31) = 0 (ArrayBuffer is zero-initialized)
    }
  }

  /** Writes the current world modelMatrix for each managed key (per-frame). */
  private writeModelMatrices(n: number): void {
    const f32 = this.cpuF32;
    for (let i = 0; i < n; i++) {
      const key = this.managedKeys[i]!;
      const b = (i * OBJECT_STRIDE) / 4;
      const mat = key.transform.getTransform().getWorldMatrix() as Float32Array;
      f32.set(mat, b + 8);
    }
  }

  private writeShadowModelMatrices(n: number): void {
    const f32 = this.cpuShadowF32;
    for (let i = 0; i < n; i++) {
      const key = this.shadowKeys[i]!;
      const b = (i * OBJECT_STRIDE) / 4;
      const mat = key.transform.getTransform().getWorldMatrix() as Float32Array;
      f32.set(mat, b + 8);
    }
  }

  private writeShadowStaticData(n: number): void {
    const f32 = this.cpuShadowF32;
    const u32 = this.cpuShadowU32;
    for (let i = 0; i < n; i++) {
      const key = this.shadowKeys[i]!;
      const b = (i * OBJECT_STRIDE) / 4;
      const aabb = key.aabb;
      if (aabb) {
        f32[b + 0] = aabb.min[0] ?? 0;
        f32[b + 1] = aabb.min[1] ?? 0;
        f32[b + 2] = aabb.min[2] ?? 0;
        f32[b + 3] = 0;
        f32[b + 4] = aabb.max[0] ?? 0;
        f32[b + 5] = aabb.max[1] ?? 0;
        f32[b + 6] = aabb.max[2] ?? 0;
        f32[b + 7] = 0;
      }
      u32[b + 24] = key.mesh.getIndexCount();
      u32[b + 25] = 1; // instanceCount (shadow keys are never instanced)
      u32[b + 26] = 0;
      u32[b + 27] = 0;
      u32[b + 28] = 0;
    }
  }

  /**
   * Extracts 6 frustum planes from the camera's viewProjection matrix into `out`.
   * Order: left, right, top, bottom, near, far (Gribb-Hartmann, column-major gl-matrix).
   */
  private extractFrustumPlanesTo(camera: Camera, out: Float32Array): void {
    mat4.multiply(this.viewProj, camera.getProjection(), camera.getView());
    const m = this.viewProj;
    const p = out;

    // gl-matrix column-major storage:
    //  col0: m[0],m[1],m[2],m[3]   col1: m[4],m[5],m[6],m[7]
    //  col2: m[8],m[9],m[10],m[11] col3: m[12],m[13],m[14],m[15]
    // Row i: m[i], m[4+i], m[8+i], m[12+i]

    // Left:   row3 + row0
    p[0] = m[3] + m[0];
    p[1] = m[7] + m[4];
    p[2] = m[11] + m[8];
    p[3] = m[15] + m[12];
    // Right:  row3 - row0
    p[4] = m[3] - m[0];
    p[5] = m[7] - m[4];
    p[6] = m[11] - m[8];
    p[7] = m[15] - m[12];
    // Top:    row3 - row1
    p[8] = m[3] - m[1];
    p[9] = m[7] - m[5];
    p[10] = m[11] - m[9];
    p[11] = m[15] - m[13];
    // Bottom: row3 + row1
    p[12] = m[3] + m[1];
    p[13] = m[7] + m[5];
    p[14] = m[11] + m[9];
    p[15] = m[15] + m[13];
    // Near:   row3 + row2
    p[16] = m[3] + m[2];
    p[17] = m[7] + m[6];
    p[18] = m[11] + m[10];
    p[19] = m[15] + m[14];
    // Far:    row3 - row2
    p[20] = m[3] - m[2];
    p[21] = m[7] - m[6];
    p[22] = m[11] - m[10];
    p[23] = m[15] - m[14];
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  /** Total keys currently managed by GPU culling (indirect draw). */
  public getManagedCount(): number {
    return this.managedKeys.length;
  }

  /** The managed key list — exposed for CPU-side visible-count estimation in the debug UI. */
  public getManagedKeys(): RenderKey[] {
    return this.managedKeys;
  }

  /**
   * The GPU buffer containing per-object AABB + modelMatrix + draw args.
   * Exposed so HZBCullingPass can bind it for the occlusion test.
   * Returns null when the main culling buffer has not been built yet.
   */
  public getObjectDataBuffer(): GPUBuffer | null {
    return this.built && this.managedKeys.length > 0 ? this.objectDataBuffer : null;
  }

  /**
   * The GPU buffer of DrawIndexedIndirectParameters written by the frustum pass.
   * Exposed so HZBCullingPass can read and further zero occluded entries.
   * Returns null when the main culling buffer has not been built yet.
   */
  public getIndirectArgsBuffer(): GPUBuffer | null {
    return this.built && this.managedKeys.length > 0 ? this.indirectArgsBuffer : null;
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  public dispose(): void {
    // Release main culling buffer assignments
    for (const key of this.managedKeys) {
      key.indirectDrawBuffer = undefined;
      key.indirectDrawOffset = 0;
    }
    // Release shadow culling buffer assignments
    for (const key of this.shadowKeys) {
      key.shadowIndirectOffset = -1;
    }

    this.objectDataBuffer?.destroy();
    this.frustumBuffer?.destroy();
    this.indirectArgsBuffer?.destroy();

    this.shadowObjectDataBuffer?.destroy();
    for (const buf of this.shadowIndirectPool) buf.destroy();
    for (const buf of this.shadowFrustumPool) buf.destroy();
    this.shadowIndirectPool = [];
    this.shadowFrustumPool = [];
    this.shadowBindGroupPool = [];

    this.managedKeys = [];
    this.shadowKeys = [];
    this.capacity = 0;
    this.shadowCapacity = 0;
    this.built = false;
    this.shadowBuilt = false;
    this.initialized = false;
  }
}
