import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';

/** What gi/common/gi_sampling.wgsl reads: params, probe state, volumes, both atlases. */
export interface GIProbeResources {
  params: GPUBuffer;
  probeState: GPUBuffer;
  volumes: GPUBuffer;
  irradiance: GPUTextureView;
  visibility: GPUTextureView;
}

/** GIParams size (gi/common/gi_common.wgsl). */
const PARAMS_BYTES = 320;

/**
 * The GI probe volumes for passes outside RealtimeGI that light things the deferred ambient pass
 * doesn't reach: lit particles, the water surface (docs/realtime-gi-plan.md, phase 5).
 * RealtimeGI publishes its resources while it lights the frame; otherwise consumers get empty
 * stand-ins (0 volumes → giSampleIrradiance returns coverage 0), so a shader that blends
 * `gi + baked · (1 − coverage)` falls back to the baked probes without a permutation.
 *
 * Consumers append layoutEntries() to their bind group layout, entries() to the bind group, and
 * rebuild the bind group when getVersion() changes. Declared in WGSL as (base = first binding):
 *   base + 0 giParams (uniform)        base + 3 giIrradianceAtlas
 *   base + 1 giProbeState (storage)    base + 4 giVisibilityAtlas
 *   base + 2 giVolumes (storage)       base + 5 giSampler (filtering)
 */
export class GISharedResources {
  private static current: GIProbeResources | null = null;
  private static empty: GIProbeResources | null = null;
  private static version = 0;

  /** RealtimeGI: its resources while it lights the frame, null otherwise. */
  public static publish(resources: GIProbeResources | null): void {
    const c = GISharedResources.current;
    const same =
      c === resources ||
      (!!c &&
        !!resources &&
        c.params === resources.params &&
        c.probeState === resources.probeState &&
        c.volumes === resources.volumes &&
        c.irradiance === resources.irradiance &&
        c.visibility === resources.visibility);
    if (same) return;
    GISharedResources.current = resources;
    GISharedResources.version++;
  }

  /** Changes whenever entries() would return different resources. */
  public static getVersion(): number {
    return GISharedResources.version;
  }

  public static isLive(): boolean {
    return GISharedResources.current !== null;
  }

  public static layoutEntries(visibility: number, base: number): GPUBindGroupLayoutEntry[] {
    return [
      { binding: base, visibility, buffer: { type: 'uniform' } },
      { binding: base + 1, visibility, buffer: { type: 'read-only-storage' } },
      { binding: base + 2, visibility, buffer: { type: 'read-only-storage' } },
      { binding: base + 3, visibility, texture: { sampleType: 'float' } },
      { binding: base + 4, visibility, texture: { sampleType: 'float' } },
      { binding: base + 5, visibility, sampler: { type: 'filtering' } },
    ];
  }

  public static entries(base: number): GPUBindGroupEntry[] {
    const r = GISharedResources.current ?? GISharedResources.getEmpty();
    return [
      { binding: base, resource: { buffer: r.params } },
      { binding: base + 1, resource: { buffer: r.probeState } },
      { binding: base + 2, resource: { buffer: r.volumes } },
      { binding: base + 3, resource: r.irradiance },
      { binding: base + 4, resource: r.visibility },
      { binding: base + 5, resource: SamplerLibrary.simpleSampler! },
    ];
  }

  private static getEmpty(): GIProbeResources {
    if (!GISharedResources.empty) {
      const device = GPUUtils.getDevice();
      const usage = GPUBufferUsage.UNIFORM;
      const storage = GPUBufferUsage.STORAGE;
      const texture = device.createTexture({
        label: 'gi_empty_atlas',
        size: { width: 1, height: 1 },
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = texture.createView();
      GISharedResources.empty = {
        // All zero: gridInfo.y (volume count) = 0.
        params: GPUUtils.createBuffer('gi_empty_params', PARAMS_BYTES, usage),
        probeState: GPUUtils.createBuffer('gi_empty_state', 32, storage),
        volumes: GPUUtils.createBuffer('gi_empty_volumes', 48, storage),
        irradiance: view,
        visibility: view,
      };
    }
    return GISharedResources.empty;
  }
}
