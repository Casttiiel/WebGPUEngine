/**
 * Advanced blur configuration system inspired by optimized Gaussian blur techniques.
 * Provides configurable blur parameters, weights, and presets for high-quality blur effects.
 */

export interface BlurWeights {
  center: number;     // Weight for center sample (w0)
  first: number;      // Weight for first ring (w1)
  second: number;     // Weight for second ring (w2)
  third: number;      // Weight for third ring (w3)
}

export interface BlurDistanceFactors {
  first: number;      // Distance factor for first ring
  second: number;     // Distance factor for second ring
  third: number;      // Distance factor for third ring
  fourth: number;     // Distance factor for fourth ring (unused in 7-tap)
}

export interface AdvancedBlurParameters {
  weights: BlurWeights;
  distanceFactors: BlurDistanceFactors;
  globalDistance: number;
  maxSteps: number;
  activeSteps: number;
}

export type BlurPreset = 'box' | 'gaussian' | 'linear' | 'preset1' | 'preset2';

export class AdvancedBlurConfig {
  private static readonly BLUR_PRESETS: Record<BlurPreset, AdvancedBlurParameters> = {
    box: {
      weights: { center: 1.0, first: 1.0, second: 1.0, third: 1.0 },
      distanceFactors: { first: 1.0, second: 2.0, third: 3.0, fourth: 4.0 },
      globalDistance: 1.0,
      maxSteps: 3,
      activeSteps: 3,
    },
    gaussian: {
      // Pascal's triangle weights: 1 8 28 56 70 56 28 8 1 (normalized to 4 taps)
      weights: { center: 70.0, first: 56.0, second: 28.0, third: 8.0 },
      distanceFactors: { first: 1.0, second: 2.0, third: 3.0, fourth: 4.0 },
      globalDistance: 1.0,
      maxSteps: 4,
      activeSteps: 4,
    },
    linear: {
      // Optimized linear sampling for 5-tap kernel
      // http://rastergrid.com/blog/2010/09/efficient-gaussian-blur-with-linear-sampling/
      weights: { center: 0.2270270270, first: 0.3162162162, second: 0.0702702703, third: 0.0 },
      distanceFactors: { first: 1.3846153846, second: 3.2307692308, third: 0.0, fourth: 0.0 },
      globalDistance: 1.0,
      maxSteps: 2,
      activeSteps: 2,
    },
    preset1: {
      weights: { center: 70.0, first: 56.0, second: 28.0, third: 8.0 },
      distanceFactors: { first: 1.0, second: 2.0, third: 3.0, fourth: 4.0 },
      globalDistance: 2.7,
      maxSteps: 3,
      activeSteps: 3,
    },
    preset2: {
      weights: { center: 70.0, first: 56.0, second: 28.0, third: 8.0 },
      distanceFactors: { first: 1.0, second: 2.0, third: 3.0, fourth: 4.0 },
      globalDistance: 2.0,
      maxSteps: 2,
      activeSteps: 2,
    },
  };

  /**
   * Get blur parameters for the specified preset
   */
  public static getPreset(preset: BlurPreset): AdvancedBlurParameters {
    return { ...this.BLUR_PRESETS[preset] };
  }

  /**
   * Normalize weights for GPU uniform buffer (vec4)
   */
  public static normalizeWeights(weights: BlurWeights): Float32Array {
    const totalWeight = weights.center + 2 * (weights.first + weights.second + weights.third);
    return new Float32Array([
      weights.center / totalWeight,
      weights.first / totalWeight,
      weights.second / totalWeight,
      weights.third / totalWeight,
    ]);
  }

  /**
   * Convert distance factors to GPU uniform buffer (vec4)
   */
  public static getDistanceFactorsArray(factors: BlurDistanceFactors): Float32Array {
    return new Float32Array([factors.first, factors.second, factors.third, factors.fourth]);
  }

  /**
   * Calculate optimal step count based on quality settings
   */
  public static getOptimalStepCount(quality: 'low' | 'medium' | 'high'): number {
    switch (quality) {
      case 'low':
        return 2;
      case 'medium':
        return 3;
      case 'high':
        return 4;
      default:
        return 3;
    }
  }

  /**
   * Get recommended preset based on quality
   */
  public static getQualityPreset(quality: 'low' | 'medium' | 'high'): BlurPreset {
    switch (quality) {
      case 'low':
        return 'linear'; // Optimized 2-tap linear sampling
      case 'medium':
        return 'preset2'; // Balanced quality/performance
      case 'high':
        return 'gaussian'; // Full quality Gaussian
      default:
        return 'preset2';
    }
  }

  /**
   * Create a custom blur configuration
   */
  public static createCustomConfig(
    weights: Partial<BlurWeights>,
    distanceFactors: Partial<BlurDistanceFactors>,
    globalDistance: number = 1.0,
    steps: number = 3,
  ): AdvancedBlurParameters {
    return {
      weights: {
        center: weights.center ?? 70.0,
        first: weights.first ?? 56.0,
        second: weights.second ?? 28.0,
        third: weights.third ?? 8.0,
      },
      distanceFactors: {
        first: distanceFactors.first ?? 1.0,
        second: distanceFactors.second ?? 2.0,
        third: distanceFactors.third ?? 3.0,
        fourth: distanceFactors.fourth ?? 4.0,
      },
      globalDistance,
      maxSteps: steps,
      activeSteps: steps,
    };
  }
}
