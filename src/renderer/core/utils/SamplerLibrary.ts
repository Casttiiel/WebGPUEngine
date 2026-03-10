import { GPUUtils } from './GPUUtils';

export class SamplerLibrary {
  private static initialized = false;

  private static _simpleSampler: GPUSampler;
  private static _bloomSampler: GPUSampler;
  private static _ambientOcclusionSampler: GPUSampler;
  private static _shadowsSampler: GPUSampler;
  private static _anisotropic16x: GPUSampler;
  private static _skyboxSampler: GPUSampler;
  private static _nonFilteringSampler: GPUSampler;
  private static _froxelRaymarchSampler: GPUSampler;
  private static _environmentCubemapSampler: GPUSampler;

  /**
   * Initialize all samplers. Must be called after WebGPU device is ready.
   */
  public static initialize(): void {
    if (SamplerLibrary.initialized) {
      console.warn('SamplerLibrary already initialized');
      return;
    }

    // Creating reusable samplers...

    SamplerLibrary._simpleSampler = GPUUtils.createSampler({
      label: 'fxaa_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._bloomSampler = GPUUtils.createSampler({
      label: 'bloom_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._skyboxSampler = GPUUtils.createSampler({
      label: 'skybox_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._ambientOcclusionSampler = GPUUtils.createSampler({
      label: 'ambient_occlusion_sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._shadowsSampler = GPUUtils.createSampler({
      label: 'shadows_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      compare: 'less',
    });

    SamplerLibrary._anisotropic16x = GPUUtils.createSampler({
      label: 'anisotropic_16x',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 16,
    });

    SamplerLibrary._nonFilteringSampler = GPUUtils.createSampler({
      label: 'non_filtering_sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._froxelRaymarchSampler = GPUUtils.createSampler({
      label: 'froxel_raymarch_sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 1,
    });

    SamplerLibrary._environmentCubemapSampler = GPUUtils.createSampler({
      label: 'environment_cubemap_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary.initialized = true;
    // All samplers created successfully
  }

  /**
   * Cleanup all samplers. Call during engine shutdown.
   */
  public static destroy(): void {
    if (!SamplerLibrary.initialized) return;

    // Cleaning up samplers...

    // Note: WebGPU samplers are automatically cleaned up when device is destroyed
    // But we set references to null for explicit cleanup
    SamplerLibrary._simpleSampler = null as any;
    SamplerLibrary._bloomSampler = null as any;
    SamplerLibrary._ambientOcclusionSampler = null as any;
    SamplerLibrary._shadowsSampler = null as any;
    SamplerLibrary._anisotropic16x = null as any;
    SamplerLibrary._skyboxSampler = null as any;
    SamplerLibrary._nonFilteringSampler = null as any;
    SamplerLibrary._froxelRaymarchSampler = null as any;
    SamplerLibrary._environmentCubemapSampler = null as any;

    SamplerLibrary.initialized = false;
  }

  public static get bloom(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._bloomSampler;
  }

  public static get simpleSampler(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._simpleSampler;
  }

  public static get ambientOcclusionSampler(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._ambientOcclusionSampler;
  }

  public static get shadows(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._shadowsSampler;
  }

  public static get anisotropic16x(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._anisotropic16x;
  }

  public static get skybox(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._skyboxSampler;
  }

  public static get nonFilteringSampler(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._nonFilteringSampler;
  }

  public static get froxelRaymarchSampler(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._froxelRaymarchSampler;
  }

  public static get environmentCubemap(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._environmentCubemapSampler;
  }
}
