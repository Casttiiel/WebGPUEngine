interface CPUSample {
  lastMs: number;
  avgMs: number;
  count: number;
  accum: number;
}

export class CPUProfiler {
  private samples = new Map<string, CPUSample>();
  private stack: { name: string; t0: number }[] = [];

  public begin(name: string): void {
    this.stack.push({ name, t0: performance.now() });
  }

  public end(): void {
    const entry = this.stack.pop();
    if (!entry) return;

    const ms = performance.now() - entry.t0;
    let s = this.samples.get(entry.name);
    if (!s) {
      s = { lastMs: 0, avgMs: 0, count: 0, accum: 0 };
      this.samples.set(entry.name, s);
    }
    s.lastMs = ms;
    s.count++;
    s.accum += ms;
    s.avgMs = s.accum / s.count;
  }

  public getMs(name: string): number {
    return this.samples.get(name)?.lastMs ?? 0;
  }

  public getAvgMs(name: string): number {
    return this.samples.get(name)?.avgMs ?? 0;
  }

  public reset(): void {
    this.samples.clear();
    this.stack.length = 0;
  }
}
