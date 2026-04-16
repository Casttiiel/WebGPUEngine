import { ResourceManager } from '../../../core/engine/ResourceManager';
import { Camera } from '../../../core/math/Camera';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory } from '../factories/PipelineFactory';
import { GPUUtils } from '../utils/GPUUtils';
import { HZBBuilder } from './HZBBuilder';

// ---- Layout constants -------------------------------------------------------

/** CameraHZBData uniform struct size (bytes): mat4×4 [64] + vec4 [16] = 80. */
const CAMERA_HZB_SIZE = 80;

/** ObjectData stride in bytes — must match frustum_culling_indirect.cs. */
const OBJECT_STRIDE = 128;

/** DrawIndexedIndirectParameters stride — 5 × u32 = 20 bytes. */
const INDIRECT_STRIDE = 20;

/**
 * HZB Occlusion Culling Pass
 *
 * Runs a compute shader (hzb_culling.cs) AFTER the frustum cull dispatch and
 * BEFORE the GBuffer render pass.  Uses the HZB pyramid built from the
 * *previous* frame's depth to further zero out `instanceCount` for objects
 * that are occluded by scene geometry — at zero GPU readback cost.
 *
 * Integration (RenderManagerV2.performCulling):
 *   1. gpuCuller.dispatch(encoder, camera)   ← frustum cull
 *   2. hzbCullingPass.dispatch(encoder, camera, ...)  ← this class
 *   3. GBuffer render pass uses the combined indirect args
 */
export class HZBCullingPass {
  private device!: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private layout!: GPUBindGroupLayout;

  /** Per-frame camera/HZB uniform buffer (CameraHZBData, 80 bytes). */
  private cameraBuffer!: GPUBuffer;
  private cpuCamera = new Float32Array(CAMERA_HZB_SIZE / 4); // 20 floats
  // ---- Debug readback: count objects culled by HZB each frame -------------
  /** Atomic counter written by the shader (STORAGE | COPY_SRC | COPY_DST). */
  private counterBuffer!: GPUBuffer;
  /** CPU-visible staging copy (MAP_READ | COPY_DST). */
  private stagingBuffer!: GPUBuffer;
  /** Typed array used to reset the counter to zero every frame. */
  private readonly zeroU32 = new Uint32Array([0]);
  /** Result from the most recently completed GPU readback. */
  private lastCulledCount = 0;

  /**
   * Readback state machine (2 mutually-exclusive phases):
   *
   *  IDLE         mapPending=F  stagingMapped=F
   *    → End of dispatch():  submit isolated copy encoder, call mapAsync()  → mapPending=T
   *  MAP_PENDING
   *    → mapAsync resolves:                                                  → mapPending=F, stagingMapped=T
   *  STAGED
   *    → Next dispatch() start: read + unmap                                → stagingMapped=F  (back to IDLE)
   */
  private mapPending = false; // mapAsync in flight
  private stagingMapped = false; // data ready to read via getMappedRange
  /** Set when the counter copy was recorded into the current frame's main encoder. */
  private counterCopyInMainEncoder = false;

  // ---- Debug: per-cull breakdown output -----------------------------------
  /**
   * Set when the debug copy was recorded into the current frame's main encoder.
   * postFrame() reads this flag and starts mapAsync after endFrame() submits.
   */
  private debugCopyInMainEncoder = false;
  // Buffer layout (all atomic<u32>):
  //   [0]           = count of recorded culls (max 32)
  //   [1 + i*12 .. 1 + i*12 + 11] for each cull i:
  //     [0] objectIdx  [1] ndcMinZ_bits  [2] hzbMaxDepth_bits  [3] mip
  //     [4] tx0  [5] ty0  [6] tx1  [7] ty1
  //     [8] uvMinX_bits  [9] uvMaxX_bits  [10] uvMinY_bits  [11] uvMaxY_bits
  // Total: (1 + 32*12) * 4 = 1540 bytes
  private static readonly DEBUG_BUF_SIZE = (1 + 32 * 12) * 4;
  private debugOutputBuffer!: GPUBuffer;
  private debugOutputStaging!: GPUBuffer;
  private readonly zeroU32debug = new Uint32Array([0]);
  private debugMapPending = false;
  private debugStagingMapped = false;
  /** Set to true by RenderManagerV2 when debug readback is active. */
  public debugEnabled = false;

  // ---- Bind group cache: avoid per-frame recreation ----------------------
  private cachedBindGroup: GPUBindGroup | null = null;
  private cachedObjectDataBuffer: GPUBuffer | null = null;
  private cachedIndirectArgsBuffer: GPUBuffer | null = null;
  private cachedObjectCount = -1;
  private cachedHZBView: GPUTextureView | null = null;

  private initialized = false;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  public async initialize(): Promise<void> {
    this.device = GPUUtils.getDevice();

    const shaderCode = await ResourceManager.loadShader('utility/hzb_culling.cs');

    // Bind group layout matching hzb_culling.cs:
    //   @binding(0) uniform       CameraHZBData
    //   @binding(1) storage-r     ObjectData[]             (same buffer as frustum pass)
    //   @binding(2) storage-rw    DrawArgs[]               (same buffer as frustum pass)
    //   @binding(3) texture_2d<f32>  r32float → unfilterable-float   (HZB pyramid)
    //   @binding(4) storage-rw    atomic<u32>              culledCount
    //   @binding(5) storage-rw    array<atomic<u32>>       hzbDebug
    this.layout = BindGroupFactory.getLayout('hzb_culling_layout_v2', [
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
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ]);

    const module = this.device.createShaderModule({
      label: 'hzb_culling_shader',
      code: shaderCode,
    });

    const pipelineLayout = PipelineFactory.createPipelineLayout('hzb_culling_pipeline_layout_v2', [
      this.layout,
    ]);

    this.pipeline = PipelineFactory.createComputePipeline({
      label: 'hzb_culling_pipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'main' },
    });

    this.cameraBuffer = this.device.createBuffer({
      label: 'hzb_culling_camera',
      size: CAMERA_HZB_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Atomic counter (4 bytes): written by shader, copied to staging each frame.
    this.counterBuffer = this.device.createBuffer({
      label: 'hzb_culled_counter',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // CPU-visible staging buffer for async readback of the counter.
    this.stagingBuffer = this.device.createBuffer({
      label: 'hzb_culled_staging',
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Debug per-cull breakdown buffer (binding 5).
    this.debugOutputBuffer = this.device.createBuffer({
      label: 'hzb_debug_output',
      size: HZBCullingPass.DEBUG_BUF_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.debugOutputStaging = this.device.createBuffer({
      label: 'hzb_debug_staging',
      size: HZBCullingPass.DEBUG_BUF_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Per-frame dispatch
  // --------------------------------------------------------------------------

  /**
   * Dispatches the HZB occlusion culling compute pass.
   *
   * @param encoder            Current frame's command encoder.
   * @param camera             The main camera.
   * @param objectDataBuffer   Per-object AABB+modelMatrix+drawArgs buffer (from GPUCullingManager).
   * @param indirectArgsBuffer Indirect draw args written by the frustum pass (from GPUCullingManager).
   * @param objectCount        Number of managed objects in both buffers.
   * @param hzbBuilder         HZB pyramid built from the previous frame's depth.
   */
  public dispatch(
    encoder: GPUCommandEncoder,
    camera: Camera,
    objectDataBuffer: GPUBuffer,
    indirectArgsBuffer: GPUBuffer,
    objectCount: number,
    hzbBuilder: HZBBuilder,
  ): void {
    if (!this.initialized || objectCount === 0 || !hzbBuilder.isReady()) return;

    const hzbView = hzbBuilder.getHZBView();
    if (!hzbView) return;

    // ---- Readback state machine ----------------------------------------------------
    //
    // MAP_PENDING → STAGED: mapAsync has resolved; data ready to read next dispatch.
    // STAGED → IDLE: consume the staged data, unmap, reset.
    // (IDLE → MAP_PENDING transition now happens at the END of dispatch, not here.)

    // Phase 3 → IDLE: consume the staged counter data.
    if (this.stagingMapped) {
      const data = new Uint32Array(this.stagingBuffer.getMappedRange());
      this.lastCulledCount = data[0]!;
      this.stagingBuffer.unmap();
      this.stagingMapped = false;
    }
    // Debug breakdown: consume if ready.
    if (this.debugStagingMapped) {
      this.logDebugOutput();
      this.debugOutputStaging.unmap();
      this.debugStagingMapped = false;
    }

    // ---- Reset atomic counter + debug count via writeBuffer ----------------
    this.device.queue.writeBuffer(this.counterBuffer, 0, this.zeroU32);
    // Always reset the debug count so stale entries from a previous frame are
    // not replayed.  The buffer write is cheap (4 bytes) regardless of debugEnabled.
    this.device.queue.writeBuffer(this.debugOutputBuffer, 0, this.zeroU32debug);

    // ---- Update camera uniform ---------------------------------------------
    // Use the unjittered view-projection for AABB screen-space projection.
    //
    // The depth prepass is rendered with the JITTERED projection (for TAA), which
    // shifts every rasterized pixel by a sub-pixel amount.  If we project object
    // AABBs through the SAME jittered VP, the resulting screen UVs are shifted by
    // the jitter too — but the HZB texels are at INTEGER pixel boundaries, so the
    // object's own depth may land in a NEIGHBORING texel rather than the one our
    // UV computation targets.  For small objects (< 2 screen pixels), this 0.5px
    // shift is enough to miss the object's own depth entirely, causing a false cull.
    //
    // Using the UNJITTERED VP gives stable screen UVs aligned with the pixel grid,
    // so the ±1 texel expansion in the shader reliably brackets the object's depth.
    // The small positional error vs the jittered depth is absorbed by the expansion.
    const vpMatrix = camera.getUnjitteredViewProjection();
    for (let i = 0; i < 16; i++) {
      this.cpuCamera[i] = vpMatrix[i]!;
    }
    // hzbWidth (float 16), hzbHeight (float 17), hzbMipCount (float 18), _pad (float 19)
    this.cpuCamera[16] = hzbBuilder.getWidth();
    this.cpuCamera[17] = hzbBuilder.getHeight();
    this.cpuCamera[18] = hzbBuilder.getMipCount();
    this.cpuCamera[19] = 0.0;

    this.device.queue.writeBuffer(this.cameraBuffer, 0, this.cpuCamera);

    // ---- Build bind group (cached — only recreate when inputs change) ------
    if (
      this.cachedBindGroup === null ||
      this.cachedObjectDataBuffer !== objectDataBuffer ||
      this.cachedIndirectArgsBuffer !== indirectArgsBuffer ||
      this.cachedObjectCount !== objectCount ||
      this.cachedHZBView !== hzbView
    ) {
      this.cachedBindGroup = this.device.createBindGroup({
        label: 'hzb_culling_bind_group',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer } },
          {
            binding: 1,
            resource: { buffer: objectDataBuffer, size: objectCount * OBJECT_STRIDE },
          },
          {
            binding: 2,
            resource: { buffer: indirectArgsBuffer, size: objectCount * INDIRECT_STRIDE },
          },
          { binding: 3, resource: hzbView },
          { binding: 4, resource: { buffer: this.counterBuffer } },
          { binding: 5, resource: { buffer: this.debugOutputBuffer } },
        ],
      });
      this.cachedObjectDataBuffer = objectDataBuffer;
      this.cachedIndirectArgsBuffer = indirectArgsBuffer;
      this.cachedObjectCount = objectCount;
      this.cachedHZBView = hzbView;
    }
    const bindGroup = this.cachedBindGroup;

    // ---- Dispatch ----------------------------------------------------------
    const workgroups = Math.ceil(objectCount / 64);
    const pass = encoder.beginComputePass({ label: 'hzb_occlusion_culling' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups, 1, 1);
    pass.end();

    // ---- Readback — record counter copy into the MAIN encoder --------------
    // The counter is in the same encoder as the compute pass.  postFrame() will
    // start mapAsync after Render.endFrame() submits the encoder.
    if (!this.counterCopyInMainEncoder && !this.mapPending && !this.stagingMapped) {
      encoder.copyBufferToBuffer(this.counterBuffer, 0, this.stagingBuffer, 0, 4);
      this.counterCopyInMainEncoder = true;
    }

    // ---- Debug breakdown readback ------------------------------------------
    // Record the copy INTO the main frame encoder so the compute pass's writes
    // are guaranteed to be visible before the copy executes.  A separate encoder
    // submitted before the main one would read stale (previous-frame) data.
    // postFrame() is called after Render.endFrame() submits the main encoder,
    // at which point it is safe to call mapAsync on the staging buffer.
    if (this.debugEnabled && !this.debugMapPending && !this.debugStagingMapped) {
      encoder.copyBufferToBuffer(
        this.debugOutputBuffer,
        0,
        this.debugOutputStaging,
        0,
        HZBCullingPass.DEBUG_BUF_SIZE,
      );
      this.debugCopyInMainEncoder = true;
    }
  }

  /**
   * Must be called AFTER Render.endFrame() submits the main frame encoder.
   * Starts mapAsync on counter and debug staging buffers if copies were recorded this frame.
   */
  public postFrame(): void {
    // Counter readback
    if (this.counterCopyInMainEncoder && !this.mapPending && !this.stagingMapped) {
      this.counterCopyInMainEncoder = false;
      this.mapPending = true;
      this.stagingBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.mapPending = false;
          this.stagingMapped = true;
        })
        .catch(() => {
          this.mapPending = false;
          this.counterCopyInMainEncoder = false;
        });
    }

    // Debug breakdown readback
    if (this.debugCopyInMainEncoder && !this.debugMapPending && !this.debugStagingMapped) {
      this.debugCopyInMainEncoder = false;
      this.debugMapPending = true;
      this.debugOutputStaging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.debugMapPending = false;
          this.debugStagingMapped = true;
        })
        .catch(() => {
          this.debugMapPending = false;
          this.debugCopyInMainEncoder = false;
        });
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  /**
   * Returns the number of objects HZB-culled in the most recent completed frame.
   * Updates once per frame with a 1-frame GPU readback lag.
   */
  public getCulledCount(): number {
    return this.lastCulledCount;
  }

  // --------------------------------------------------------------------------
  // Debug log
  // --------------------------------------------------------------------------

  private logDebugOutput(): void {
    const u32 = new Uint32Array(this.debugOutputStaging.getMappedRange());
    const f32 = new Float32Array(u32.buffer);
    const count = Math.min(u32[0]!, 32);
    if (count === 0) return;

    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const b = 1 + i * 12;
      const objIdx = u32[b + 0]!;
      const ndcMinZ = f32[b + 1]!;
      const hzbMaxDepth = f32[b + 2]!;
      const mip = u32[b + 3]!;
      const tx0 = u32[b + 4]!,
        ty0 = u32[b + 5]!;
      const tx1 = u32[b + 6]!,
        ty1 = u32[b + 7]!;
      const uvMinX = f32[b + 8]!,
        uvMaxX = f32[b + 9]!;
      const uvMinY = f32[b + 10]!,
        uvMaxY = f32[b + 11]!;
      const diff = ndcMinZ - hzbMaxDepth;
      lines.push(
        `  [${i}] obj=${objIdx}  ndcMinZ=${ndcMinZ.toFixed(5)}  hzb=${hzbMaxDepth.toFixed(5)}` +
          `  DIFF=${diff > 0 ? '+' : ''}${diff.toFixed(5)}  mip=${mip}` +
          `  tx=[${tx0},${tx1}]  ty=[${ty0},${ty1}]` +
          `  uvX=[${uvMinX.toFixed(4)},${uvMaxX.toFixed(4)}]  uvY=[${uvMinY.toFixed(4)},${uvMaxY.toFixed(4)}]`,
      );
    }
    console.warn(`[HZB CULL BREAKDOWN] ${count} culled this frame:\n` + lines.join('\n'));
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  public dispose(): void {
    this.cameraBuffer?.destroy();
    this.counterBuffer?.destroy();
    // The staging buffer must be unmapped before destroy; if mapAsync is still
    // in flight the spec allows destroying — the promise rejection is silenced.
    this.stagingBuffer?.destroy();
    this.debugOutputBuffer?.destroy();
    this.debugOutputStaging?.destroy();
    this.cachedBindGroup = null;
    this.cachedObjectDataBuffer = null;
    this.cachedIndirectArgsBuffer = null;
    this.cachedObjectCount = -1;
    this.cachedHZBView = null;
    this.initialized = false;
    this.counterCopyInMainEncoder = false;
    this.debugCopyInMainEncoder = false;
    this.mapPending = false;
    this.stagingMapped = false;
  }
}
