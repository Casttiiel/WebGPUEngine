import { Profiler } from './Profiler';
import { GPUProfiler } from './GPUProfiler';

/**
 * PerfRecorder — frame-by-frame performance capture for diagnosing stutter.
 *
 * An average of "60 fps" hides hitches: a single 50 ms frame every second still averages
 * ~58 fps but feels laggy. This records every frame while active and reports percentiles,
 * hitches and what each of the worst frames was doing.
 *
 * Per frame: real interval between rAF callbacks, CPU update / render time and CPU scopes,
 * JS heap (drops ⇒ garbage collection), main-thread long tasks, and counters for work that
 * typically causes hitches when it happens mid-game: pipeline compiles, bind group
 * creation, buffer uploads, texture loads / streaming upgrades. GPU side: raw per-frame
 * pass timings (timestamp queries) and the submit → GPU-done latency of each frame.
 *
 * Zero cost when not recording (every hook checks `recording` first).
 * Driven from the console / MCP: `__engine.perf.capture(seconds)`.
 */

export type PerfCounter =
  | 'pipelineSync'
  | 'pipelineAsync'
  | 'bindGroups'
  | 'bufferWrites'
  | 'textureLoads'
  | 'textureStreams';

interface FrameSample {
  index: number;
  time: number; // ms since capture start
  interval: number; // ms since previous frame callback
  updateMs: number;
  renderMs: number;
  scopes: Record<string, number>;
  heapMB: number;
  heapDropMB: number; // > 0 ⇒ a GC happened since the previous frame
  counters: Record<PerfCounter, number>;
  pipelineMs: number; // CPU ms spent creating pipelines this frame
  bufferWriteKB: number;
  longTaskMs: number; // long tasks that ended during this frame
  gpuMs?: number; // raw GPU total of the frame (sum of profiled passes)
  gpuSpanMs?: number; // GPU wall-clock span of the frame (first → last profiled pass)
  gpuLatencyMs?: number; // submit → queue idle
}

interface PerfCaptureReport {
  frames: number;
  /** rAF callbacks skipped by the frame latency limiter (GPU still busy). */
  skippedByLatencyLimiter: number;
  seconds: number;
  fps: number;
  frameInterval: Stats;
  hitches: { over1_5xMedian: number; over25ms: number; over50ms: number; over100ms: number };
  cpu: { update: Stats; render: Stats; scopesAvg: Record<string, number> };
  gpu: {
    supported: boolean;
    total: Stats | null;
    span: Stats | null;
    latency: Stats | null;
    passesAvg: Record<string, number>;
    /** Unprofiled GPU time between passes, attributed to the preceding pass. */
    gapsAvg: Record<string, number>;
  };
  gc: { events: number; freedMB: number; heapStartMB: number; heapEndMB: number };
  longTasks: { count: number; totalMs: number; maxMs: number };
  counters: Record<PerfCounter, number> & { pipelineCompileMs: number; bufferWriteKB: number };
  worstFrames: Array<Omit<FrameSample, 'counters' | 'scopes'> & Record<string, unknown>>;
  diagnosis: string[];
}

interface Stats {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

const COUNTERS: PerfCounter[] = [
  'pipelineSync',
  'pipelineAsync',
  'bindGroups',
  'bufferWrites',
  'textureLoads',
  'textureStreams',
];

const r2 = (v: number) => Math.round(v * 100) / 100;

function stats(values: number[]): Stats {
  if (values.length === 0) return { avg: 0, p50: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return { avg: r2(avg), p50: r2(pick(0.5)), p90: r2(pick(0.9)), p99: r2(pick(0.99)), max: r2(sorted[sorted.length - 1]!) };
}

export class PerfRecorder {
  private static recording = false;
  private static frames: FrameSample[] = [];
  private static startTime = 0;
  private static lastFrameTime = 0;
  private static frameIndex = 0;
  private static lastHeapMB = 0;
  private static heapStartMB = 0;

  // Accumulated during the current frame
  private static counters = PerfRecorder.emptyCounters();
  private static pipelineMs = 0;
  private static bufferWriteBytes = 0;
  private static longTaskMs = 0;

  // GPU
  private static gpuPassSums = new Map<string, number>();
  private static gpuPassFrames = 0;
  private static gpuGapSums = new Map<string, number>();
  private static longTasks: number[] = [];
  private static longTaskObserver: PerformanceObserver | null = null;

  public static isRecording(): boolean {
    return this.recording;
  }

  private static emptyCounters(): Record<PerfCounter, number> {
    return Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<PerfCounter, number>;
  }

  private static heapMB(): number {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? mem.usedJSHeapSize / (1024 * 1024) : 0;
  }

  // ── Control ─────────────────────────────────────────────────────────────────

  public static start(): void {
    this.frames = [];
    this.frameIndex = 0;
    this.counters = this.emptyCounters();
    this.pipelineMs = 0;
    this.bufferWriteBytes = 0;
    this.longTaskMs = 0;
    this.longTasks = [];
    this.gpuPassSums.clear();
    this.gpuGapSums.clear();
    this.gpuPassFrames = 0;
    this.skipped = 0;
    this.startTime = performance.now();
    this.lastFrameTime = 0;
    this.lastHeapMB = this.heapStartMB = this.heapMB();

    this.longTaskObserver?.disconnect();
    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.longTasks.push(e.duration);
          this.longTaskMs += e.duration;
        }
      });
      this.longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch {
      this.longTaskObserver = null; // longtask not supported
    }
    this.recording = true;
  }

  public static stop(): PerfCaptureReport {
    this.recording = false;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    return this.buildReport();
  }

  /** Records for `seconds` of real time and returns the report. */
  public static async capture(seconds: number): Promise<PerfCaptureReport> {
    this.start();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0.5, seconds) * 1000));
    return this.stop();
  }

  // ── Hooks ───────────────────────────────────────────────────────────────────

  private static skipped = 0;

  /** A rAF callback skipped by the frame latency limiter (GPU still busy). */
  public static skippedFrame(): void {
    if (this.recording) this.skipped++;
  }

  /** Count hitch-prone work (no-op unless recording). */
  public static count(kind: PerfCounter, n = 1): void {
    if (this.recording) this.counters[kind] += n;
  }

  public static addPipelineTime(ms: number): void {
    if (this.recording) this.pipelineMs += ms;
  }

  public static addBufferWrite(bytes: number): void {
    if (!this.recording) return;
    this.counters.bufferWrites++;
    this.bufferWriteBytes += bytes;
  }

  /** Called by Render.endFrame right after queue.submit(). */
  public static onSubmit(device: GPUDevice): void {
    if (!this.recording) return;
    const frame = this.frameIndex;
    const t0 = performance.now();
    device.queue.onSubmittedWorkDone().then(() => {
      const sample = this.frames.find((f) => f.index === frame);
      if (sample) sample.gpuLatencyMs = r2(performance.now() - t0);
    });
  }

  /** Called once per rAF callback by main.ts, after update + render. */
  public static frame(nowMs: number, updateMs: number, renderMs: number): void {
    if (!this.recording) return;

    const heap = this.heapMB();
    const heapDrop = this.lastHeapMB - heap;
    this.lastHeapMB = heap;

    const cpu = Profiler.getInstance().cpu;
    const scopes: Record<string, number> = {};
    for (const s of ['Entities', 'Shadows', 'Deferred', 'Post-Process']) scopes[s] = r2(cpu.getMs(s));

    // Raw GPU timings of the most recent readback (2–3 frames behind)
    const gpu = GPUProfiler.getInstance();
    const raw = gpu.getLastFrameRaw();
    let gpuMs: number | undefined;
    let gpuSpanMs: number | undefined;
    if (raw && raw.frame !== this.lastGpuFrame) {
      gpuSpanMs = gpu.getLastFrameSpanMs();
      for (const [name, ms] of gpu.getLastFrameGaps()) {
        this.gpuGapSums.set(name, (this.gpuGapSums.get(name) ?? 0) + ms);
      }
      this.lastGpuFrame = raw.frame;
      gpuMs = 0;
      for (const [name, ms] of raw.results) {
        gpuMs += ms;
        this.gpuPassSums.set(name, (this.gpuPassSums.get(name) ?? 0) + ms);
      }
      this.gpuPassFrames++;
    }

    this.frames.push({
      index: this.frameIndex,
      time: r2(nowMs - this.startTime),
      interval: this.lastFrameTime === 0 ? 0 : r2(nowMs - this.lastFrameTime),
      updateMs: r2(updateMs),
      renderMs: r2(renderMs),
      scopes,
      heapMB: r2(heap),
      heapDropMB: heapDrop > 0.5 ? r2(heapDrop) : 0,
      counters: this.counters,
      pipelineMs: r2(this.pipelineMs),
      bufferWriteKB: r2(this.bufferWriteBytes / 1024),
      longTaskMs: r2(this.longTaskMs),
      ...(gpuMs !== undefined ? { gpuMs: r2(gpuMs) } : {}),
      ...(gpuSpanMs !== undefined ? { gpuSpanMs: r2(gpuSpanMs) } : {}),
    });

    this.lastFrameTime = nowMs;
    this.frameIndex++;
    this.counters = this.emptyCounters();
    this.pipelineMs = 0;
    this.bufferWriteBytes = 0;
    this.longTaskMs = 0;
  }

  private static lastGpuFrame = -1;

  // ── Report ──────────────────────────────────────────────────────────────────

  private static buildReport(): PerfCaptureReport {
    // Drop the first frame (no interval) for interval stats
    const frames = this.frames;
    const timed = frames.filter((f) => f.interval > 0);
    const intervals = timed.map((f) => f.interval);
    const interval = stats(intervals);
    const seconds = frames.length ? frames[frames.length - 1]!.time / 1000 : 0;

    const gpuTotals = frames.filter((f) => f.gpuMs !== undefined).map((f) => f.gpuMs!);
    const gpuLat = frames.filter((f) => f.gpuLatencyMs !== undefined).map((f) => f.gpuLatencyMs!);
    const gpuSpans = frames.filter((f) => f.gpuSpanMs !== undefined).map((f) => f.gpuSpanMs!);

    const totals = this.emptyCounters();
    let pipelineCompileMs = 0;
    let bufferWriteKB = 0;
    for (const f of frames) {
      for (const c of COUNTERS) totals[c] += f.counters[c];
      pipelineCompileMs += f.pipelineMs;
      bufferWriteKB += f.bufferWriteKB;
    }

    const scopesAvg: Record<string, number> = {};
    for (const f of frames) for (const [k, v] of Object.entries(f.scopes)) scopesAvg[k] = (scopesAvg[k] ?? 0) + v;
    for (const k of Object.keys(scopesAvg)) scopesAvg[k] = r2(scopesAvg[k]! / Math.max(frames.length, 1));

    const passesAvg: Record<string, number> = {};
    [...this.gpuPassSums.entries()]
      .map(([k, v]) => [k, v / Math.max(this.gpuPassFrames, 1)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([k, v]) => (passesAvg[k] = r2(v)));

    const gapsAvg: Record<string, number> = {};
    [...this.gpuGapSums.entries()]
      .map(([k, v]) => [k, v / Math.max(this.gpuPassFrames, 1)] as const)
      .filter(([, v]) => v >= 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .forEach(([k, v]) => (gapsAvg[k] = r2(v)));

    const gcFrames = frames.filter((f) => f.heapDropMB > 0);
    const median = interval.p50 || 16.67;

    const worstFrames = [...timed]
      .sort((a, b) => b.interval - a.interval)
      .slice(0, 10)
      .map((f) => {
        const nonZero = Object.fromEntries(COUNTERS.filter((c) => f.counters[c] > 0).map((c) => [c, f.counters[c]]));
        const { counters: _c, scopes, ...rest } = f;
        return { ...rest, ...scopes, ...nonZero };
      });

    const report: PerfCaptureReport = {
      frames: frames.length,
      skippedByLatencyLimiter: this.skipped,
      seconds: r2(seconds),
      fps: r2(timed.length / Math.max(intervals.reduce((s, v) => s + v, 0) / 1000, 1e-3)),
      frameInterval: interval,
      hitches: {
        over1_5xMedian: intervals.filter((v) => v > median * 1.5).length,
        over25ms: intervals.filter((v) => v > 25).length,
        over50ms: intervals.filter((v) => v > 50).length,
        over100ms: intervals.filter((v) => v > 100).length,
      },
      cpu: {
        update: stats(frames.map((f) => f.updateMs)),
        render: stats(frames.map((f) => f.renderMs)),
        scopesAvg,
      },
      gpu: {
        supported: GPUProfiler.getInstance().supported,
        total: gpuTotals.length ? stats(gpuTotals) : null,
        span: gpuSpans.length ? stats(gpuSpans) : null,
        latency: gpuLat.length ? stats(gpuLat) : null,
        passesAvg,
        gapsAvg,
      },
      gc: {
        events: gcFrames.length,
        freedMB: r2(gcFrames.reduce((s, f) => s + f.heapDropMB, 0)),
        heapStartMB: r2(this.heapStartMB),
        heapEndMB: r2(this.lastHeapMB),
      },
      longTasks: {
        count: this.longTasks.length,
        totalMs: r2(this.longTasks.reduce((s, v) => s + v, 0)),
        maxMs: r2(this.longTasks.length ? Math.max(...this.longTasks) : 0),
      },
      counters: { ...totals, pipelineCompileMs: r2(pipelineCompileMs), bufferWriteKB: r2(bufferWriteKB) },
      worstFrames,
      diagnosis: [],
    };
    report.diagnosis = this.diagnose(report, frames);
    return report;
  }

  /** Plain-language hints derived from the numbers. */
  private static diagnose(r: PerfCaptureReport, frames: FrameSample[]): string[] {
    const d: string[] = [];
    const n = Math.max(frames.length, 1);
    const cpuFrame = r.cpu.update.avg + r.cpu.render.avg;

    if (r.hitches.over1_5xMedian > n * 0.02) {
      d.push(`Stutter: ${r.hitches.over1_5xMedian} of ${n} frames took >1.5× the median interval (${r.frameInterval.p50} ms).`);
    }
    if (r.gpu.span && r.gpu.total && r.gpu.span.avg - r.gpu.total.avg > 2) {
      d.push(`Unprofiled GPU work: frame span ${r.gpu.span.avg} ms vs ${r.gpu.total.avg} ms in profiled passes — copies / mip generation / passes without timestamps.`);
    }
    if (r.gpu.total && r.gpu.total.avg > 14) {
      d.push(`GPU-bound: GPU time averages ${r.gpu.total.avg} ms (p99 ${r.gpu.total.p99}) against a 16.7 ms budget.`);
    }
    if (r.gpu.latency && r.gpu.latency.p50 > 25) {
      d.push(`High GPU latency (${r.gpu.latency.p50} ms submit→done): frames queue up on the GPU — input feels delayed even at 60 fps.`);
    }
    if (cpuFrame > 12) d.push(`CPU-heavy: update+render average ${r2(cpuFrame)} ms per frame.`);
    if (r.gc.events > 0) {
      const gcHitches = frames.filter((f) => f.heapDropMB > 0 && f.interval > r.frameInterval.p50 * 1.5).length;
      d.push(`GC: ${r.gc.events} collections freed ${r.gc.freedMB} MB (${gcHitches} coincided with slow frames) — reduce per-frame allocations.`);
    }
    if (r.longTasks.count > 0) d.push(`Main thread blocked by ${r.longTasks.count} long tasks (max ${r.longTasks.maxMs} ms).`);
    if (r.counters.pipelineSync > 0) {
      d.push(`${r.counters.pipelineSync} synchronous pipeline compiles during the capture (${r.counters.pipelineCompileMs} ms CPU) — each one can hitch.`);
    }
    if (r.counters.bindGroups / n > 20) d.push(`${r2(r.counters.bindGroups / n)} bind groups created per frame — should be cached.`);
    if (r.counters.textureStreams + r.counters.textureLoads > 0) {
      d.push(`${r.counters.textureLoads} texture loads and ${r.counters.textureStreams} streaming upgrades during the capture (uploads + mip generation).`);
    }
    if (d.length === 0) d.push('No obvious problem: frame pacing, CPU and GPU are within budget.');
    return d;
  }
}
