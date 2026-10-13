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

  /** Timestamp pairs per frame (a label used N times in a frame takes N pairs). */
  private static readonly MAX_PASSES = 256;
  private static readonly RING_SIZE = 3;

  private _supported = false;
  private _enabled = false;

  private querySet!: GPUQuerySet;
  private resolveBuffers: GPUBuffer[] = [];
  private readbackBuffers: GPUBuffer[] = [];

  /**
   * Query pairs are handed out per CALL within a frame, so a label used several times
   * (one shadow pass per point-light face, per spot light…) gets one pair per use and
   * the readback SUMS them. A single pair per label would be overwritten by every reuse
   * and only the last pass would be measured.
   */
  private frameLabels: string[] = []; // label of each pair used this frame
  private slotLabels: string[][] = [[], [], []]; // snapshot per ring slot

  /** Exponential moving average of each pass's GPU time (ms), over the passes run last frame. */
  private results = new Map<string, number>();
  /**
   * Weight of the newest frame in the moving average. Browsers quantize timestamps (Chrome:
   * 100 µs unless chrome://flags/#enable-webgpu-developer-features is on), so a pass shorter
   * than that reads 0 one frame and 0.1 ms the next; averaging recovers its real mean cost.
   */
  private static readonly SMOOTHING = 0.1;

  private slotState: SlotState[] = ['idle', 'idle', 'idle'];
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
    this.frameLabels = [];
    this.frameIndex = 0;
    this.slotState = ['idle', 'idle', 'idle'];
    GPUProfiler._instance = null;
  }

  // ─── Pass registration ─────────────────────────────────────────────────────

  /**
   * Returns `timestampWrites` for a render or compute pass descriptor.
   * Every call gets its own query pair for this frame; results are summed per label.
   * Returns `undefined` when profiling is inactive or the frame's pairs are exhausted.
   */
  public getTimestampWrites(passName: string): GPUComputePassTimestampWrites | undefined {
    if (!this._supported || !this._enabled) return undefined;
    if (this.frameLabels.length >= GPUProfiler.MAX_PASSES) return undefined;

    const idx = this.frameLabels.length;
    this.frameLabels.push(passName);

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
    const count = this.frameLabels.length;
    if (!this._supported || !this._enabled || count === 0) {
      this.frameLabels = [];
      return;
    }

    const slot = this.frameIndex % GPUProfiler.RING_SIZE;
    if (this.slotState[slot] === 'idle') {
      const resolveBuffer = this.resolveBuffers[slot]!;
      const readbackBuffer = this.readbackBuffers[slot]!;
      encoder.resolveQuerySet(this.querySet, 0, count * 2, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, count * 2 * 8);
      this.slotState[slot] = 'recorded';
      this.slotLabels[slot] = this.frameLabels;
    }
    // Otherwise the slot is still being read back: skip measuring this frame.
    this.frameLabels = [];
  }

  /**
   * Call once per frame, AFTER `device.queue.submit()`.
   * Kicks off an async readback of the slot that was written 2 frames ago,
   * then advances the internal frame counter.
   */
  public tick(): void {
    if (this._supported && this._enabled) {
      // (frameIndex + 1) % RING_SIZE is the slot written exactly 2 frames ago.
      // Proof: current slot = frameIndex % 3.  2-frames-ago slot = (frameIndex - 2 + 3) % 3
      //        = (frameIndex + 1) % 3.  Never overlaps current slot because
      //        frameIndex % 3 ≠ (frameIndex + 1) % 3 for RING_SIZE > 1.
      const readSlot = (this.frameIndex + 1) % GPUProfiler.RING_SIZE;

      if (this.slotState[readSlot] === 'recorded') {
        this.slotState[readSlot] = 'mapping';
        const labels = this.slotLabels[readSlot] ?? [];
        const countSnap = labels.length;
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
            // Sum this frame's pairs per label. A pass that ran always counts, even when
            // quantization makes it read 0 (or end < begin) — it must not vanish.
            const frameResults = new Map<string, number>();
            for (let i = 0; i < countSnap; i++) {
              const begin = data[i * 2] ?? 0n;
              const end = data[i * 2 + 1] ?? 0n;
              const name = labels[i]!;
              const ms = end > begin ? Number(end - begin) / 1_000_000 : 0;
              frameResults.set(name, (frameResults.get(name) ?? 0) + ms);
            }
            // Smooth passes that keep running; drop passes that stopped running.
            const a = GPUProfiler.SMOOTHING;
            const smoothed = new Map<string, number>();
            for (const [name, ms] of frameResults) {
              const prev = this.results.get(name);
              smoothed.set(name, prev === undefined ? ms : prev + (ms - prev) * a);
            }
            this.results = smoothed;
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
