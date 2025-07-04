/**
 * Configuration for post-processing texture formats and quality levels.
 * Maps quality levels to appropriate texture formats for post-processing effects.
 */

export interface PostProcessingFormats {
  aoTexture: GPUTextureFormat;        // Ambient occlusion output
  toneMappingTexture: GPUTextureFormat; // Tone mapping intermediate
  aliasingTexture: GPUTextureFormat;   // Anti-aliasing intermediate
  bloomTexture: GPUTextureFormat;      // Bloom effect buffers
  skyboxTexture: GPUTextureFormat;     // Skybox/environment textures
  // Future: distortionTexture, depthOfFieldTexture, etc.
}

export class PostProcessingQualityConfig {
  private static readonly QUALITY_CONFIGS: Record<'low' | 'medium' | 'high', PostProcessingFormats> = {
    low: {
      aoTexture: 'r8unorm',           // 8 bits - sufficient for AO
      toneMappingTexture: 'rgba8unorm', // 32 bits - LDR output
      aliasingTexture: 'rgba8unorm',   // 32 bits - final output
      bloomTexture: 'rgba8unorm',      // 32 bits - bloom effect
      skyboxTexture: 'rgba8unorm',     // 32 bits - compressed skybox
    },
    medium: {
      aoTexture: 'r16float',          // 16 bits - better precision
      toneMappingTexture: 'rgba16float', // 64 bits - HDR intermediate
      aliasingTexture: 'rgba16float',   // 64 bits - higher precision
      bloomTexture: 'rgba16float',      // 64 bits - HDR bloom
      skyboxTexture: 'rgba16float',     // 64 bits - HDR skybox
    },
    high: {
      aoTexture: 'r16float',          // 16 bits - same as medium (AO doesn't need more)
      toneMappingTexture: 'rgba16float', // 64 bits - HDR precision
      aliasingTexture: 'rgba16float',   // 64 bits - highest quality
      bloomTexture: 'rgba16float',      // 64 bits - HDR bloom
      skyboxTexture: 'rgba16float',     // 64 bits - highest quality skybox
    },
  };

  /**
   * Get texture formats for the specified quality level
   */
  public static getFormats(quality: 'low' | 'medium' | 'high'): PostProcessingFormats {
    return this.QUALITY_CONFIGS[quality];
  }

  /**
   * Get estimated VRAM usage per pixel for the specified quality level (in bytes)
   */
  public static getMemoryUsagePerPixel(quality: 'low' | 'medium' | 'high'): number {
    const formats = this.getFormats(quality);
    let totalBytes = 0;

    totalBytes += this.getFormatSize(formats.aoTexture);
    totalBytes += this.getFormatSize(formats.toneMappingTexture);
    totalBytes += this.getFormatSize(formats.aliasingTexture);
    totalBytes += this.getFormatSize(formats.bloomTexture);
    totalBytes += this.getFormatSize(formats.skyboxTexture);

    return totalBytes;
  }

  /**
   * Get the size in bytes for a specific texture format
   */
  private static getFormatSize(format: GPUTextureFormat): number {
    switch (format) {
      case 'r8unorm': return 1;        // 8 bits = 1 byte
      case 'rg8unorm': return 2;       // 8 bits × 2 channels = 2 bytes  
      case 'rgba8unorm': return 4;     // 8 bits × 4 channels = 4 bytes
      case 'r16float': return 2;       // 16 bits = 2 bytes
      case 'rg16float': return 4;      // 16 bits × 2 channels = 4 bytes
      case 'rgba16float': return 8;    // 16 bits × 4 channels = 8 bytes
      case 'r32float': return 4;       // 32 bits = 4 bytes
      case 'rg32float': return 8;      // 32 bits × 2 channels = 8 bytes
      case 'rgba32float': return 16;   // 32 bits × 4 channels = 16 bytes
      default: return 4;               // Default fallback
    }
  }

  /**
   * Estimate total VRAM usage for post-processing at a given resolution
   */
  public static estimateVRAMUsage(
    width: number, 
    height: number, 
    quality: 'low' | 'medium' | 'high'
  ): number {
    const bytesPerPixel = this.getMemoryUsagePerPixel(quality);
    const totalPixels = width * height;
    return totalPixels * bytesPerPixel;
  }

  /**
   * Get a quality level recommendation based on available VRAM
   */
  public static getRecommendedQuality(
    width: number,
    height: number,
    availableVRAM: number
  ): 'low' | 'medium' | 'high' {
    const highUsage = this.estimateVRAMUsage(width, height, 'high');
    const mediumUsage = this.estimateVRAMUsage(width, height, 'medium');
    
    if (availableVRAM >= highUsage * 2) return 'high';    // 2x buffer
    if (availableVRAM >= mediumUsage * 1.5) return 'medium'; // 1.5x buffer
    return 'low';
  }
}
