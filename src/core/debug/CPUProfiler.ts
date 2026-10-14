interface CPUSample {
  lastMs: number;
  avgMs: number;
  count: number;
  accum: number;
}

export class CPUProfiler {
  private samples = new Map<string, CPUSample>();
  // Parallel stacks instead of one {name, t0} object per begin() (runs several times a frame)
  private stackNames: string[] = [];
  private stackT0: number[] = [];

  public begin(name: string): void {
    this.stackNames.push(name);
    this.stackT0.push(performance.now());
  }

  public end(): void {
    const name = this.stackNames.pop();
    const t0 = this.stackT0.pop();
    if (name === undefined || t0 === undefined) return;

    const ms = performance.now() - t0;
    let s = this.samples.get(name);
    if (!s) {
      s = { lastMs: 0, avgMs: 0, count: 0, accum: 0 };
      this.samples.set(name, s);
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
    this.stackNames.length = 0;
    this.stackT0.length = 0;
  }
}
