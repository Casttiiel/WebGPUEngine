type SlotState = 'idle' | 'recorded' | 'mapping';

/**
 * GPU profiler using WebGPU timestamp queries.
 *
 * Ring-buffer design (RING_SIZE = 3):
 *   - Frame N  : write timestamps → resolveBuffer[N % 3] → readbackBuffer[N % 3]
 *   - Frame N+2: mapAsync on readbackBuffer[(N+1) % 3]  (2 frames old, GPU done)
 *
 * Requires `timestamp-query` device feature. Gracefully becomes a no-op when
 * the feature is unavailable.
 *
 * Usage:
 *   // Initialization (called once from Render.initialize)
 *   GPUProfiler.getInstance().initialize(device, adapter.features.has('timestamp-query'));
 *
 *   // Per-pass (injected automatically by BaseRenderPass.execute)
 *   descriptor.timestampWrites = GPUProfiler.getInstance().getTimestampWrites(passLabel);
 *
 *   // End of frame (called by Render.endFrame, before encoder.finish)
 *   GPUProfiler.getInstance().resolve(encoder);
 *   device.queue.submit([encoder.finish()]);
 *   GPUProfiler.getInstance().tick();
 */
export class GPUProfiler {
  private static _instance: GPUProfiler | null = null;

  private static readonly MAX_PASSES = 64;
  private static readonly RING_SIZE = 3;

  private _supported = false;
  private _enabled = false;

  private querySet!: GPUQuerySet;
  private resolveBuffers: GPUBuffer[] = [];
  private readbackBuffers: GPUBuffer[] = [];

  private passNames: string[] = [];
  private passMap = new Map<string, number>();
  private passCount = 0;

  private results = new Map<string, number>();

  private slotState: SlotState[] = ['idle', 'idle', 'idle'];
  private slotPassCount: number[] = [0, 0, 0];
  private frameIndex = 0;

  private constructor() {}

  public static getInstance(): GPUProfiler {
    if (!GPUProfiler._instance) GPUProfiler._instance = new GPUProfiler();
    return GPUProfiler._instance;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  public initialize(device: GPUDevice, supportsTimestamps: boolean): void {
    this._supported = supportsTimestamps;
    if (!supportsTimestamps) return;

    const bufSize = GPUProfiler.MAX_PASSES * 2 * 8; // BigInt64, 8 bytes each

    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: GPUProfiler.MAX_PASSES * 2, // begin + end per pass
    });

    for (let i = 0; i < GPUProfiler.RING_SIZE; i++) {
      this.resolveBuffers.push(
        device.createBuffer({
          label: `gpu_profiler_resolve_${i}`,
          size: bufSize,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        }),
      );
      this.readbackBuffers.push(
        device.createBuffer({
          label: `gpu_profiler_readback_${i}`,
          size: bufSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
    }

    this._enabled = true;
  }

  public dispose(): void {
    this.querySet?.destroy();
    for (const b of this.resolveBuffers) b.destroy();
    for (const b of this.readbackBuffers) b.destroy();
    this.resolveBuffers = [];
    this.readbackBuffers = [];
    this.results.clear();
    this.passMap.clear();
    this.passCount = 0;
    this.frameIndex = 0;
    this.slotState = ['idle', 'idle', 'idle'];
    GPUProfiler._instance = null;
  }

  // ─── Pass registration ─────────────────────────────────────────────────────

  /**
   * Returns `timestampWrites` for a render or compute pass descriptor.
   * Lazily registers the pass name on first call.
   * Returns `undefined` when profiling is inactive.
   */
  public getTimestampWrites(passName: string): GPUComputePassTimestampWrites | undefined {
    if (!this._supported || !this._enabled) return undefined;

    let idx = this.passMap.get(passName);
    if (idx === undefined) {
      if (this.passCount >= GPUProfiler.MAX_PASSES) return undefined;
      idx = this.passCount++;
      this.passMap.set(passName, idx);
      this.passNames[idx] = passName;
    }

    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: idx * 2,
      endOfPassWriteIndex: idx * 2 + 1,
    };
  }

  // ─── Per-frame calls ────────────────────────────────────────────────────────

  /**
   * Call once per frame, BEFORE `encoder.finish()`.
   * Resolves the timestamp query set into the current ring slot and copies it
   * to the matching CPU-readable readback buffer.
   */
  public resolve(encoder: GPUCommandEncoder): void {
    if (!this._supported || !this._enabled || this.passCount === 0) return;

    const slot = this.frameIndex % GPUProfiler.RING_SIZE;
    if (this.slotState[slot] !== 'idle') return; // Slot still being read, skip frame

    const resolveBuffer = this.resolveBuffers[slot]!;
    const readbackBuffer = this.readbackBuffers[slot]!;

    encoder.resolveQuerySet(this.querySet, 0, this.passCount * 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, this.passCount * 2 * 8);

    this.slotState[slot] = 'recorded';
    this.slotPassCount[slot] = this.passCount;
  }

  /**
   * Call once per frame, AFTER `device.queue.submit()`.
   * Kicks off an async readback of the slot that was written 2 frames ago,
   * then advances the internal frame counter.
   */
  public tick(): void {
    if (this._supported && this._enabled && this.passCount > 0) {
      // (frameIndex + 1) % RING_SIZE is the slot written exactly 2 frames ago.
      // Proof: current slot = frameIndex % 3.  2-frames-ago slot = (frameIndex - 2 + 3) % 3
      //        = (frameIndex + 1) % 3.  Never overlaps current slot because
      //        frameIndex % 3 ≠ (frameIndex + 1) % 3 for RING_SIZE > 1.
      const readSlot = (this.frameIndex + 1) % GPUProfiler.RING_SIZE;

      if (this.slotState[readSlot] === 'recorded') {
        this.slotState[readSlot] = 'mapping';
        const countSnap = this.slotPassCount[readSlot] ?? 0;
        const buf = this.readbackBuffers[readSlot];
        if (!buf) {
          this.slotState[readSlot] = 'idle';
          this.frameIndex++;
          return;
        }

        buf
          .mapAsync(GPUMapMode.READ)
          .then(() => {
            const data = new BigInt64Array(buf.getMappedRange(0, countSnap * 2 * 8));
            for (let i = 0; i < countSnap; i++) {
              const begin = data[i * 2] ?? 0n;
              const end = data[i * 2 + 1] ?? 0n;
              const name = this.passNames[i];
              if (end > begin && name !== undefined) {
                this.results.set(name, Number(end - begin) / 1_000_000);
              }
            }
            buf.unmap();
            this.slotState[readSlot] = 'idle';
          })
          .catch(() => {
            // Device lost or context destroyed — reset gracefully.
            this.slotState[readSlot] = 'idle';
          });
      }
    }

    this.frameIndex++;
  }

  // ─── Accessors ──────────────────────────────────────────────────────────────

  public getMs(passName: string): number {
    return this.results.get(passName) ?? 0;
  }

  public getAllResults(): ReadonlyMap<string, number> {
    return this.results;
  }

  public get supported(): boolean {
    return this._supported;
  }

  public get enabled(): boolean {
    return this._enabled;
  }

  public set enabled(v: boolean) {
    this._enabled = v;
  }

  public isActive(): boolean {
    return this._supported && this._enabled;
  }
}
