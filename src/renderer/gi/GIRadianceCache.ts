import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { GPUUtils } from '../core/utils/GPUUtils';

/** GICacheCell in gi/common/gi_cache.wgsl: radiance, sample, info (3 × vec4). */
const CELL_BYTES = 48;
/** Header of the active list (gi_cache_compact.cs GICacheActive): count, evictFrames, pad ×2. */
const ACTIVE_HEADER_BYTES = 16;
/** Frames a cell survives without being hit by a probe or gather ray. */
const EVICT_FRAMES = 90;

/**
 * World-space radiance cache (docs/realtime-gi-plan.md, phase 3; shaders in
 * gi/common/gi_cache.wgsl). Probe and gather rays record their hits in hashed surface cells
 * and read the cell's radiance instead of shading the hit; this class owns the hash table and
 * runs, once per frame before the probe trace:
 *   compact — evict cells nobody hit for EVICT_FRAMES, list the live ones (gi_cache_compact.cs)
 *   update  — shade `budget` cells of that list, rotating, and blend (gi_cache_update.cs;
 *             the budget is GIParams.cacheInfo.y)
 * Shading cost then follows the number of surfaces in view, not the number of rays.
 */
export class GIRadianceCache {
  /** Hash slots (power of two, GIParams.cacheInfo.x). */
  public readonly capacity: number;
  public readonly keysBuffer: GPUBuffer;
  public readonly cellsBuffer: GPUBuffer;
  private activeBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer | null = null;
  private readbackPending = false;
  private destroyed = false;
  private liveCells = 0;

  private compactLayout: GPUBindGroupLayout;
  private updateLayout: GPUBindGroupLayout;
  private compactPipeline: GPUComputePipeline | null = null;
  private updatePipeline: GPUComputePipeline | null = null;
  private compactBindGroup: GPUBindGroup;
  private updateBindGroup: GPUBindGroup;

  constructor(capacity: number) {
    this.capacity = capacity;
    const usage = GPUBufferUsage.STORAGE;
    this.keysBuffer = GPUUtils.createBuffer('gi_cache_keys', capacity * 4, usage);
    this.cellsBuffer = GPUUtils.createBuffer('gi_cache_cells', capacity * CELL_BYTES, usage);
    const header = new Uint32Array([0, EVICT_FRAMES, 0, 0]);
    const active = new Uint8Array(ACTIVE_HEADER_BYTES + capacity * 4);
    active.set(new Uint8Array(header.buffer), 0);
    this.activeBuffer = GPUUtils.createBuffer(
      'gi_cache_active',
      active.byteLength,
      usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      active,
    );

    const C = GPUShaderStage.COMPUTE;
    this.compactLayout = BindGroupFactory.getLayout('gi_cache_compact_layout', [
      { binding: 0, visibility: C, buffer: { type: 'storage' } },
    ]);
    this.updateLayout = BindGroupFactory.getLayout('gi_cache_update_layout', [
      { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
    ]);
    this.compactBindGroup = BindGroupFactory.createBindGroup(
      'gi_cache_compact_bg',
      this.compactLayout,
      [{ binding: 0, resource: { buffer: this.activeBuffer } }],
    );
    this.updateBindGroup = BindGroupFactory.createBindGroup(
      'gi_cache_update_bg',
      this.updateLayout,
      [{ binding: 0, resource: { buffer: this.activeBuffer } }],
    );
  }

  /** Builds both passes against the frame (group 0) and scene (group 1) layouts of RealtimeGI. */
  public async load(
    frameLayout: GPUBindGroupLayout,
    sceneLayout: GPUBindGroupLayout,
  ): Promise<void> {
    const device = GPUUtils.getDevice();
    const [compactCode, updateCode] = await Promise.all([
      ResourceManager.loadShader('gi/gi_cache_compact.cs'),
      ResourceManager.loadShader('gi/gi_cache_update.cs'),
    ]);
    [this.compactPipeline, this.updatePipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'gi_cache_compact',
        layout: PipelineFactory.createPipelineLayout('gi_cache_compact_pl', [
          frameLayout,
          this.compactLayout,
        ]),
        compute: {
          module: device.createShaderModule({ label: 'gi_cache_compact', code: compactCode }),
          entryPoint: 'cs',
        },
      }),
      device.createComputePipelineAsync({
        label: 'gi_cache_update',
        layout: PipelineFactory.createPipelineLayout('gi_cache_update_pl', [
          frameLayout,
          sceneLayout,
          this.updateLayout,
        ]),
        compute: {
          module: device.createShaderModule({ label: 'gi_cache_update', code: updateCode }),
          entryPoint: 'cs',
        },
      }),
    ]);
  }

  /** Evicts and lists the live cells, then shades this frame's share of them. */
  public dispatch(
    encoder: GPUCommandEncoder,
    frameBindGroup: GPUBindGroup,
    sceneBindGroup: GPUBindGroup,
    budget: number,
    run: (label: string, fn: (pass: GPUComputePassEncoder) => void) => void,
  ): void {
    if (!this.compactPipeline || !this.updatePipeline) return;
    encoder.clearBuffer(this.activeBuffer, 0, 4);
    run('GI Cache Compact', (pass) => {
      pass.setPipeline(this.compactPipeline!);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, this.compactBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.capacity / 64));
    });
    run('GI Cache Update', (pass) => {
      pass.setPipeline(this.updatePipeline!);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, sceneBindGroup);
      pass.setBindGroup(2, this.updateBindGroup);
      pass.dispatchWorkgroups(Math.ceil(budget / 64));
    });
    this.requestLiveCount(encoder);
  }

  /** Live cells at the last completed readback (menu / eval: is the budget big enough?). */
  public getLiveCells(): number {
    return this.liveCells;
  }

  /** Copies the active count for getLiveCells(), at most one readback in flight. */
  private requestLiveCount(encoder: GPUCommandEncoder): void {
    if (this.readbackPending) return;
    this.readbackBuffer ??= GPUUtils.createBuffer(
      'gi_cache_readback',
      4,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const buffer = this.readbackBuffer;
    encoder.copyBufferToBuffer(this.activeBuffer, 0, buffer, 0, 4);
    this.readbackPending = true;
    // Map after this frame's submit (the encoder is submitted at the end of the frame).
    // A destroy() meanwhile skips the map and frees the buffer here instead.
    queueMicrotask(() => {
      void GPUUtils.getDevice()
        .queue.onSubmittedWorkDone()
        .then(async () => {
          if (this.destroyed) return;
          await buffer.mapAsync(GPUMapMode.READ);
          this.liveCells = new Uint32Array(buffer.getMappedRange())[0]!;
          buffer.unmap();
        })
        .catch(() => {})
        .finally(() => {
          this.readbackPending = false;
          if (this.destroyed) buffer.destroy();
        });
    });
  }

  public destroy(): void {
    this.keysBuffer.destroy();
    this.cellsBuffer.destroy();
    this.activeBuffer.destroy();
    this.destroyed = true;
    if (!this.readbackPending) this.readbackBuffer?.destroy();
    this.readbackBuffer = null;
  }
}
