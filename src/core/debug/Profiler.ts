import { CPUProfiler } from './CPUProfiler';
import { GPUProfiler } from './GPUProfiler';

/**
 * Central profiling facade exposing both CPU and GPU profilers.
 *
 * CPU profiler — stack-based, `performance.now()` measurements:
 *   Profiler.getInstance().cpu.begin('Shadows');
 *   // ... work ...
 *   Profiler.getInstance().cpu.end();
 *
 * GPU profiler — WebGPU timestamp queries (2-frame delayed readback):
 *   // Automatically injected into BaseRenderPass.execute() via timestampWrites.
 *   // Read results from GPUProfiler directly or via this facade:
 *   Profiler.getInstance().gpu.getMs('G-Buffer Pass');
 */
export class Profiler {
  private static _instance: Profiler | null = null;

  public readonly cpu: CPUProfiler;
  public readonly gpu: GPUProfiler;

  private constructor() {
    this.cpu = new CPUProfiler();
    this.gpu = GPUProfiler.getInstance();
  }

  public static getInstance(): Profiler {
    if (!Profiler._instance) Profiler._instance = new Profiler();
    return Profiler._instance;
  }

  public static dispose(): void {
    if (Profiler._instance) {
      Profiler._instance.gpu.dispose();
      Profiler._instance = null;
    }
  }
}
