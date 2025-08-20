import { GPUUtils } from './GPUUtils';

/**
 * Biblioteca de samplers precreados para optimizar performance.
 * Los samplers son recursos costosos de crear, por lo que los reutilizamos.
 */
export class SamplerLibrary {
  private static initialized = false;

  private static _simpleSampler: GPUSampler;
  private static _bloomSampler: GPUSampler;
  private static _ambientOcclusionSampler: GPUSampler;

  // Common samplers for different use cases
  private static _linearClamp: GPUSampler;
  private static _linearRepeat: GPUSampler;
  private static _linearMirror: GPUSampler;
  private static _nearestClamp: GPUSampler;
  private static _nearestRepeat: GPUSampler;

  // Specialized samplers for 3D rendering
  private static _diffuseSampler: GPUSampler;
  private static _normalMapSampler: GPUSampler;
  private static _skyboxSampler: GPUSampler;
  private static _shadowMapSampler: GPUSampler;

  // High-quality samplers with anisotropic filtering
  private static _anisotropic2x: GPUSampler;
  private static _anisotropic4x: GPUSampler;
  private static _anisotropic8x: GPUSampler;
  private static _anisotropic16x: GPUSampler;

  /**
   * Initialize all samplers. Must be called after WebGPU device is ready.
   */
  public static initialize(): void {
    if (SamplerLibrary.initialized) {
      console.warn('SamplerLibrary already initialized');
      return;
    }

    console.log('SamplerLibrary: Creating reusable samplers...');

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

    SamplerLibrary._ambientOcclusionSampler = GPUUtils.createSampler({
      label: 'aambient_occlusion_sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    // Basic samplers
    SamplerLibrary._linearClamp = GPUUtils.createSampler({
      label: 'linear_clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._linearRepeat = GPUUtils.createSampler({
      label: 'linear_repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 1,
    });

    SamplerLibrary._linearMirror = GPUUtils.createSampler({
      label: 'linear_mirror',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'mirror-repeat',
      addressModeV: 'mirror-repeat',
      maxAnisotropy: 1,
    });

    SamplerLibrary._nearestClamp = GPUUtils.createSampler({
      label: 'nearest_clamp',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 1,
    });

    SamplerLibrary._nearestRepeat = GPUUtils.createSampler({
      label: 'nearest_repeat',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 1,
    });

    // 3D rendering samplers
    SamplerLibrary._diffuseSampler = GPUUtils.createSampler({
      label: 'diffuse_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 4, // Good balance for diffuse textures
    });

    SamplerLibrary._normalMapSampler = GPUUtils.createSampler({
      label: 'normal_map_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8, // Higher quality for normal maps
    });

    SamplerLibrary._skyboxSampler = GPUUtils.createSampler({
      label: 'skybox_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      maxAnisotropy: 1, // Skybox doesn't need anisotropy
    });

    SamplerLibrary._shadowMapSampler = GPUUtils.createSampler({
      label: 'shadow_map_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      compare: 'less', // For shadow map comparison
      maxAnisotropy: 1,
    });

    // Anisotropic samplers for high-quality rendering
    SamplerLibrary._anisotropic2x = GPUUtils.createSampler({
      label: 'anisotropic_2x',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 2,
    });

    SamplerLibrary._anisotropic4x = GPUUtils.createSampler({
      label: 'anisotropic_4x',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 4,
    });

    SamplerLibrary._anisotropic8x = GPUUtils.createSampler({
      label: 'anisotropic_8x',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8,
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

    SamplerLibrary.initialized = true;
    console.log('SamplerLibrary: All samplers created successfully');
  }

  /**
   * Cleanup all samplers. Call during engine shutdown.
   */
  public static destroy(): void {
    if (!SamplerLibrary.initialized) return;

    console.log('SamplerLibrary: Cleaning up samplers...');

    // Note: WebGPU samplers are automatically cleaned up when device is destroyed
    // But we set references to null for explicit cleanup
    SamplerLibrary._simpleSampler = null as any;
    SamplerLibrary._bloomSampler = null as any;
    SamplerLibrary._ambientOcclusionSampler = null as any;

    SamplerLibrary._linearClamp = null as any;
    SamplerLibrary._linearRepeat = null as any;
    SamplerLibrary._linearMirror = null as any;
    SamplerLibrary._nearestClamp = null as any;
    SamplerLibrary._nearestRepeat = null as any;
    SamplerLibrary._diffuseSampler = null as any;
    SamplerLibrary._normalMapSampler = null as any;
    SamplerLibrary._skyboxSampler = null as any;
    SamplerLibrary._shadowMapSampler = null as any;
    SamplerLibrary._anisotropic2x = null as any;
    SamplerLibrary._anisotropic4x = null as any;
    SamplerLibrary._anisotropic8x = null as any;
    SamplerLibrary._anisotropic16x = null as any;

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

  // ========== BASIC SAMPLERS ==========

  /** Linear filtering with clamp-to-edge addressing */
  public static get linearClamp(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._linearClamp;
  }

  /** Linear filtering with repeat addressing */
  public static get linearRepeat(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._linearRepeat;
  }

  /** Linear filtering with mirror-repeat addressing */
  public static get linearMirror(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._linearMirror;
  }

  /** Nearest filtering with clamp-to-edge addressing */
  public static get nearestClamp(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._nearestClamp;
  }

  /** Nearest filtering with repeat addressing */
  public static get nearestRepeat(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._nearestRepeat;
  }

  // ========== 3D RENDERING SAMPLERS ==========

  /** Optimized sampler for diffuse/albedo textures */
  public static get diffuse(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._diffuseSampler;
  }

  /** Optimized sampler for normal maps */
  public static get normalMap(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._normalMapSampler;
  }

  /** Optimized sampler for skybox/cubemap textures */
  public static get skybox(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._skyboxSampler;
  }

  /** Optimized sampler for shadow maps with depth comparison */
  public static get shadowMap(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._shadowMapSampler;
  }

  // ========== ANISOTROPIC SAMPLERS ==========

  /** Anisotropic filtering 2x */
  public static get anisotropic2x(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._anisotropic2x;
  }

  /** Anisotropic filtering 4x */
  public static get anisotropic4x(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._anisotropic4x;
  }

  /** Anisotropic filtering 8x */
  public static get anisotropic8x(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._anisotropic8x;
  }

  /** Anisotropic filtering 16x */
  public static get anisotropic16x(): GPUSampler {
    if (!SamplerLibrary.initialized) {
      throw new Error('SamplerLibrary not initialized. Call SamplerLibrary.initialize() first.');
    }
    return SamplerLibrary._anisotropic16x;
  }

  // ========== UTILITY METHODS ==========

  /**
   * Get anisotropic sampler based on quality level
   */
  public static getAnisotropicByLevel(level: number): GPUSampler {
    if (level >= 16) return SamplerLibrary.anisotropic16x;
    if (level >= 8) return SamplerLibrary.anisotropic8x;
    if (level >= 4) return SamplerLibrary.anisotropic4x;
    if (level >= 2) return SamplerLibrary.anisotropic2x;
    return SamplerLibrary.linearRepeat;
  }

  /**
   * Check if library is initialized
   */
  public static isInitialized(): boolean {
    return SamplerLibrary.initialized;
  }
}
