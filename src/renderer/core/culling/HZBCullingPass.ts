import { ResourceManager } from '../../../core/engine/ResourceManager';
import { Camera } from '../../../core/math/Camera';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory } from '../factories/PipelineFactory';
import { GPUUtils } from '../utils/GPUUtils';
import { HZBBuilder } from './HZBBuilder';
import { mat4 } from 'gl-matrix';

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
  private viewProj = mat4.create();

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
   * Readback state machine (3 mutually-exclusive phases):
   *
   *  IDLE         copyScheduled=F  mapPending=F  stagingMapped=F
   *    → Frame N end:   record copyBufferToBuffer → copyScheduled=T
   *  COPY_SCHEDULED
   *    → Frame N+1 start: call mapAsync()           → copyScheduled=F, mapPending=T
   *      (the encoder from frame N has been submitted by now — safe to mapAsync)
   *  MAP_PENDING
   *    → mapAsync resolves:                         → mapPending=F, stagingMapped=T
   *  STAGED
   *    → Frame N+2 start: read + unmap              → stagingMapped=F  (back to IDLE)
   */
  private copyScheduled = false; // copy recorded in encoder, not yet submitted
  private mapPending = false; // mapAsync in flight
  private stagingMapped = false; // data ready to read via getMappedRange

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
    this.layout = BindGroupFactory.getLayout('hzb_culling_layout', [
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
    ]);

    const module = this.device.createShaderModule({
      label: 'hzb_culling_shader',
      code: shaderCode,
    });

    const pipelineLayout = PipelineFactory.createPipelineLayout('hzb_culling_pipeline_layout', [
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

    // ---- Readback state machine (runs at the TOP of dispatch, before submit) ----
    //
    // Phase 1 → 2: the previous frame's encoder (containing copyBufferToBuffer) has
    // now been submitted.  Safe to call mapAsync — staging is not used this frame.
    if (this.copyScheduled) {
      this.copyScheduled = false;
      this.mapPending = true;
      this.stagingBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          this.mapPending = false;
          this.stagingMapped = true;
        })
        .catch(() => {
          // Device lost or buffer destroyed — reset to IDLE.
          this.mapPending = false;
          this.stagingMapped = false;
        });
    }

    // Phase 3 → IDLE: consume the staged data.
    if (this.stagingMapped) {
      const data = new Uint32Array(this.stagingBuffer.getMappedRange());
      this.lastCulledCount = data[0]!;
      this.stagingBuffer.unmap();
      this.stagingMapped = false;
    }

    // ---- Reset atomic counter via writeBuffer (queued before this submit) --
    this.device.queue.writeBuffer(this.counterBuffer, 0, this.zeroU32);

    // ---- Update camera uniform ---------------------------------------------
    mat4.multiply(this.viewProj, camera.getProjection(), camera.getView());

    // viewProj mat4 (floats 0..15)
    for (let i = 0; i < 16; i++) {
      this.cpuCamera[i] = this.viewProj[i]!;
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

    // ---- Schedule readback — IDLE phase only --------------------------------
    // copyScheduled/mapPending/stagingMapped all false → staging is 'unmapped'.
    // Record the copy into the encoder NOW; mapAsync will be called next frame
    // (after this encoder has been submitted) to avoid the
    // "used in submit while pending map" validation error.
    if (!this.copyScheduled && !this.mapPending && !this.stagingMapped) {
      encoder.copyBufferToBuffer(this.counterBuffer, 0, this.stagingBuffer, 0, 4);
      this.copyScheduled = true; // mapAsync deferred to next dispatch()
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
  // Cleanup
  // --------------------------------------------------------------------------

  public dispose(): void {
    this.cameraBuffer?.destroy();
    this.counterBuffer?.destroy();
    // The staging buffer must be unmapped before destroy; if mapAsync is still
    // in flight the spec allows destroying — the promise rejection is silenced.
    this.stagingBuffer?.destroy();
    this.cachedBindGroup = null;
    this.cachedObjectDataBuffer = null;
    this.cachedIndirectArgsBuffer = null;
    this.cachedObjectCount = -1;
    this.cachedHZBView = null;
    this.initialized = false;
    this.copyScheduled = false;
    this.mapPending = false;
    this.stagingMapped = false;
  }
}
