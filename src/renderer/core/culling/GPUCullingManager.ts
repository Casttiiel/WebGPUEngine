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

  // ---- stats / logging ----
  private frameCount = 0;
  private firstDispatch = true;

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
    console.log('[GPUCullingManager] Initialized');
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
    console.log(
      `[GPUCullingManager] Rebuilt — ${n} GPU-managed keys (${allKeys.length - n} shadows/instanced/particles kept on CPU)`,
    );
  }

  public isDirty(): boolean {
    return !this.built;
  }

  public markDirty(): void {
    this.built = false;
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

    // 1. Update frustum uniform (96 bytes, cheap)
    this.extractFrustumPlanes(camera);
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

    // Log first dispatch and then every 300 frames (~5 s at 60 fps)
    if (this.firstDispatch || this.frameCount % 300 === 0) {
      console.log(
        `%c[GPUCuller] dispatch frame=${this.frameCount} managed=${n} workgroups=${Math.ceil(n / 64)}`,
        'color:#4fc3f7',
      );
      this.firstDispatch = false;
    }
    this.frameCount++;
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
      // modelMatrix starts at byte 32 = float32 index b+8, size 64 bytes / 16 floats
      const mat = key.transform.getTransform().getWorldMatrix() as Float32Array;
      f32.set(mat, b + 8);
    }
  }

  /**
   * Extracts 6 frustum planes from the camera's viewProjection matrix.
   * Order matches FrustumPlanes struct: left, right, top, bottom, near, far.
   * Uses the Gribb-Hartmann method on a column-major gl-matrix mat4.
   */
  private extractFrustumPlanes(camera: Camera): void {
    mat4.multiply(this.viewProj, camera.getProjection(), camera.getView());
    const m = this.viewProj;
    const p = this.cpuFrustum;

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

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  public dispose(): void {
    // Release GPU buffer assignments from keys
    for (const key of this.managedKeys) {
      key.indirectDrawBuffer = undefined;
      key.indirectDrawOffset = 0;
    }

    this.objectDataBuffer?.destroy();
    this.frustumBuffer?.destroy();
    this.indirectArgsBuffer?.destroy();

    this.managedKeys = [];
    this.capacity = 0;
    this.built = false;
    this.initialized = false;
    this.frameCount = 0;
    this.firstDispatch = true;
  }
}
