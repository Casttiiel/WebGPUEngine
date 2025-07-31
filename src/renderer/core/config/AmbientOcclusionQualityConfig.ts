/**
 * Configuration for Ambient Occlusion quality levels.
 * Defines SSAO parameters optimized for different performance/quality targets.
 */

export interface AmbientOcclusionConfig {
  sampleCount: number; // Number of samples per pixel (more = better quality, slower)
  radius: number; // AO sampling radius
  bias: number; // Depth bias to prevent self-occlusion
  aoStrength: number; // AO effect intensity
  maxDistance: number; // Maximum distance for AO calculation
  noiseScale: number; // Noise texture scale for sample distribution
  enabled: boolean; // Whether AO is enabled at all
}

export class AmbientOcclusionQualityConfig {
  private static readonly QUALITY_CONFIGS: Record<
    'off' | 'low' | 'medium' | 'high',
    AmbientOcclusionConfig
  > = {
    off: {
      sampleCount: 0,
      radius: 0,
      bias: 0,
      aoStrength: 0,
      maxDistance: 0,
      noiseScale: 0,
      enabled: false,
    },
    low: {
      sampleCount: 4, // Minimal samples for performance
      radius: 0.001, // Larger radius for more detailed AO
      bias: 0.1, // Lower bias for accuracy
      aoStrength: 1.5, // Strong effect
      maxDistance: 0.8, // Shorter distance
      noiseScale: 4.0, // Standard noise scale
      enabled: true,
    },
    medium: {
      sampleCount: 8, // Balanced samples
      radius: 0.01, // Larger radius for more detailed AO
      bias: 0.1, // Lower bias for accuracy
      aoStrength: 1.5, // Strong effect
      maxDistance: 1.0, // Standard distance
      noiseScale: 4.0, // Standard noise scale
      enabled: true,
    },
    high: {
      sampleCount: 16, // High sample count for quality
      radius: 0.01, // Larger radius for more detailed AO
      bias: 0.1, // Lower bias for accuracy
      aoStrength: 1.5, // Strong effect
      maxDistance: 1.2, // Extended distance
      noiseScale: 4.0, // Standard noise scale
      enabled: true,
    },
  };

  /**
   * Get AO configuration for the specified quality level
   */
  public static getConfig(quality: 'off' | 'low' | 'medium' | 'high'): AmbientOcclusionConfig {
    return { ...this.QUALITY_CONFIGS[quality] };
  }

  /**
   * Get estimated performance impact for the specified quality level
   * Returns a relative cost multiplier (1.0 = baseline, higher = more expensive)
   */
  public static getPerformanceImpact(quality: 'off' | 'low' | 'medium' | 'high'): number {
    switch (quality) {
      case 'off':
        return 0.0; // No cost
      case 'low':
        return 1.0; // Baseline
      case 'medium':
        return 2.0; // 2x cost due to double samples
      case 'high':
        return 4.0; // 4x cost due to quadruple samples
      default:
        return 1.0;
    }
  }

  /**
   * Get recommended quality level based on target frametime budget
   * @param targetFrameTime Target frame time in milliseconds
   * @param currentFrameTime Current frame time without AO
   * @returns Recommended quality level
   */
  public static getRecommendedQuality(
    targetFrameTime: number,
    currentFrameTime: number,
  ): 'off' | 'low' | 'medium' | 'high' {
    const availableBudget = targetFrameTime - currentFrameTime;
    const baseAOCost = 2.0; // Estimated base AO cost in ms

    if (availableBudget < baseAOCost) return 'off';
    if (availableBudget < baseAOCost * 2) return 'low';
    if (availableBudget < baseAOCost * 4) return 'medium';
    return 'high';
  }

  /**
   * Get a description of what each quality level provides
   */
  public static getQualityDescription(quality: 'off' | 'low' | 'medium' | 'high'): string {
    switch (quality) {
      case 'off':
        return 'Disabled - Maximum performance, no ambient occlusion';
      case 'low':
        return 'Low - Subtle AO with minimal performance impact (8 samples)';
      case 'medium':
        return 'Medium - Balanced AO quality and performance (16 samples)';
      case 'high':
        return 'High - Detailed AO with higher quality (32 samples)';
      default:
        return 'Unknown quality level';
    }
  }

  /**
   * Validate if the current hardware can handle the specified quality level
   * @param quality Quality level to validate
   * @param gpuTier Estimated GPU tier (1=low, 2=medium, 3=high)
   * @returns Whether the quality level is suitable
   */
  public static validateQualityForHardware(
    quality: 'off' | 'low' | 'medium' | 'high',
    gpuTier: number,
  ): boolean {
    switch (quality) {
      case 'off':
        return true; // Always supported
      case 'low':
        return gpuTier >= 1; // Any GPU
      case 'medium':
        return gpuTier >= 2; // Mid-range+ GPU
      case 'high':
        return gpuTier >= 3; // High-end GPU
      default:
        return false;
    }
  }
}
