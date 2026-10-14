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
  /** Raw per-pass times of the most recent readback (for PerfRecorder). */
  private lastFrameRaw: { frame: number; results: ReadonlyMap<string, number> } | null = null;
  private readbackCount = 0;
  private lastFrameSpanMs = 0;
  private lastFrameGaps = new Map<string, number>();

  // Readback scratch, reused every frame: the readback runs once per frame, so fresh
  // Maps / tuples / BigInts here were one of the biggest per-frame GC sources.
  private frameResults = new Map<string, number>();
  private spanOrder: number[] = [];
  private spanBegin = new Float64Array(GPUProfiler.MAX_PASSES);
  private spanEnd = new Float64Array(GPUProfiler.MAX_PASSES);
  private gapKeys = new Map<string, string>(); // label → "gap after <label>"

  /** Idle/unprofiled GPU time between consecutive passes of the last read-back frame. */
  public getLastFrameGaps(): ReadonlyMap<string, number> {
    return this.lastFrameGaps;
  }

  /** GPU wall-clock span of the last read-back frame (first → last profiled pass). */
  public getLastFrameSpanMs(): number {
    return this.lastFrameSpanMs;
  }

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
      this.frameLabels.length = 0;
      return;
    }

    const slot = this.frameIndex % GPUProfiler.RING_SIZE;
    if (this.slotState[slot] === 'idle') {
      const resolveBuffer = this.resolveBuffers[slot]!;
      const readbackBuffer = this.readbackBuffers[slot]!;
      encoder.resolveQuerySet(this.querySet, 0, count * 2, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, count * 2 * 8);
      this.slotState[slot] = 'recorded';
      // Swap arrays: the slot was idle, so its previous label array is free to reuse.
      const free = this.slotLabels[slot]!;
      this.slotLabels[slot] = this.frameLabels;
      this.frameLabels = free;
    }
    // Otherwise the slot is still being read back: skip measuring this frame.
    this.frameLabels.length = 0;
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
            // Read each u64 timestamp as two u32 halves into a double: exact up to 2^53 ns
            // (~104 days of uptime) and, unlike BigInt64Array, no heap BigInt per read.
            const words = new Uint32Array(buf.getMappedRange(0, countSnap * 2 * 8));
            const begins = this.spanBegin;
            const ends = this.spanEnd;
            // Sum this frame's pairs per label. A pass that ran always counts, even when
            // quantization makes it read 0 (or end < begin) — it must not vanish.
            const frameResults = this.frameResults;
            frameResults.clear();
            let first = 0;
            let last = 0;
            for (let i = 0; i < countSnap; i++) {
              const begin = words[i * 4]! + words[i * 4 + 1]! * 4294967296;
              const end = words[i * 4 + 2]! + words[i * 4 + 3]! * 4294967296;
              begins[i] = begin;
              ends[i] = end;
              const name = labels[i]!;
              const ms = end > begin ? (end - begin) / 1_000_000 : 0;
              frameResults.set(name, (frameResults.get(name) ?? 0) + ms);
              if (begin > 0 && (first === 0 || begin < first)) first = begin;
              if (end > last) last = end;
            }
            // Wall-clock GPU span of the frame (first pass start → last pass end). The
            // difference with the sum of passes is GPU work without timestamps (copies,
            // mip generation, unprofiled passes) plus idle gaps between submissions.
            this.lastFrameSpanMs = last > first ? (last - first) / 1_000_000 : 0;

            // Where does the unprofiled time go? Sort passes by start and attribute each
            // idle gap to the pass that precedes it ("gap after X" = copies / unprofiled
            // passes recorded right after X). Exposed for PerfRecorder only.
            const order = this.spanOrder;
            order.length = 0;
            for (let i = 0; i < countSnap; i++) {
              if (begins[i]! > 0 && ends[i]! >= begins[i]!) order.push(i);
            }
            // Insertion sort: passes are recorded almost in GPU order, so this is ~O(n)
            // and, unlike Array.prototype.sort with a comparator, allocates nothing.
            for (let i = 1; i < order.length; i++) {
              const idx = order[i]!;
              const b = begins[idx]!;
              let j = i - 1;
              while (j >= 0 && begins[order[j]!]! > b) {
                order[j + 1] = order[j]!;
                j--;
              }
              order[j + 1] = idx;
            }
            const gaps = this.lastFrameGaps;
            gaps.clear();
            for (let i = 1; i < order.length; i++) {
              const prev = order[i - 1]!;
              const gap = begins[order[i]!]! - ends[prev]!;
              if (gap > 0) {
                const label = labels[prev]!;
                let key = this.gapKeys.get(label);
                if (key === undefined) {
                  key = `gap after ${label}`;
                  this.gapKeys.set(label, key);
                }
                gaps.set(key, (gaps.get(key) ?? 0) + gap / 1_000_000);
              }
            }
            // Smooth passes that keep running; drop passes that stopped running.
            const a = GPUProfiler.SMOOTHING;
            const results = this.results;
            for (const name of results.keys()) {
              if (!frameResults.has(name)) results.delete(name);
            }
            for (const [name, ms] of frameResults) {
              const prev = results.get(name);
              results.set(name, prev === undefined ? ms : prev + (ms - prev) * a);
            }
            if (this.lastFrameRaw) {
              this.lastFrameRaw.frame = this.readbackCount++;
            } else {
              this.lastFrameRaw = { frame: this.readbackCount++, results: frameResults };
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

  /** Unsmoothed pass times of the latest readback; `frame` increments per readback. */
  public getLastFrameRaw(): { frame: number; results: ReadonlyMap<string, number> } | null {
    return this.lastFrameRaw;
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
