export interface TimingInfo {
  cpuTime: number;
  gpuTime: number;
  frameTime: number;
  fps: number;
  categories: Map<string, number>;
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private device: GPUDevice;
  private timestampBuffer: GPUBuffer;
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private queryIndex = 0;
  private categories = new Map<string, number>();
  private frameStartTime = 0;
  private lastFrameTime = 0;
  private averageFPS = 0;
  private fpsUpdateInterval = 500; // Update FPS every 500ms
  private lastFpsUpdate = 0;
  private frameCount = 0;

  private constructor(device: GPUDevice) {
    this.device = device;

    // Create timestamp query set
    this.querySet = device.createQuerySet({
      type: 'timestamp',
      count: 32, // Adjust based on how many timestamps we need
    });

    // Create buffer for timestamp results
    this.timestampBuffer = device.createBuffer({
      size: 32 * 8, // 8 bytes per timestamp
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });

    // Create buffer for reading results
    this.resolveBuffer = device.createBuffer({
      size: 32 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  public static getInstance(device?: GPUDevice): PerformanceMonitor {
    if (!PerformanceMonitor.instance && device) {
      PerformanceMonitor.instance = new PerformanceMonitor(device);
    }
    return PerformanceMonitor.instance;
  }

  public beginFrame(): void {
    this.frameStartTime = performance.now();
    this.queryIndex = 0;
  }

  public beginCategory(encoder: GPUCommandEncoder, category: string): void {
    encoder.writeTimestamp(this.querySet, this.queryIndex++);
    this.categories.set(category, this.queryIndex - 1);
  }

  public endCategory(encoder: GPUCommandEncoder, category: string): void {
    encoder.writeTimestamp(this.querySet, this.queryIndex++);
  }

  public async endFrame(encoder: GPUCommandEncoder): Promise<TimingInfo> {
    // Write final timestamp
    encoder.writeTimestamp(this.querySet, this.queryIndex++);

    // Resolve timestamps
    encoder.resolveQuerySet(this.querySet, 0, this.queryIndex, this.timestampBuffer, 0);

    // Copy to mapping buffer
    encoder.copyBufferToBuffer(this.timestampBuffer, 0, this.resolveBuffer, 0, this.queryIndex * 8);

    // Calculate frame time and FPS
    const currentTime = performance.now();
    const frameTime = currentTime - this.frameStartTime;
    this.frameCount++;

    if (currentTime - this.lastFpsUpdate >= this.fpsUpdateInterval) {
      this.averageFPS = (this.frameCount * 1000) / (currentTime - this.lastFpsUpdate);
      this.lastFpsUpdate = currentTime;
      this.frameCount = 0;
    }

    // Read GPU timestamps
    await this.resolveBuffer.mapAsync(GPUMapMode.READ);
    const timings = new BigInt64Array(this.resolveBuffer.getMappedRange());

    // Convert timestamps to milliseconds using device timestamp period
    const period = this.device.queue.timestampPeriod * 1e-6; // Convert to ms
    const gpuTimings = new Map<string, number>();

    for (const [category, startIndex] of this.categories.entries()) {
      const endIndex = startIndex + 1;
      const duration = Number(timings[endIndex] - timings[startIndex]) * period;
      gpuTimings.set(category, duration);
    }

    this.resolveBuffer.unmap();

    return {
      cpuTime: frameTime,
      gpuTime: Number(timings[this.queryIndex - 1] - timings[0]) * period,
      frameTime: currentTime - this.lastFrameTime,
      fps: this.averageFPS,
      categories: gpuTimings,
    };
  }
}
