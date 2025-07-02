export interface BloomQualityConfig {
  enabled: boolean;
  maxBlurSteps: number;
  blurStrength: number;
  blendIntensity: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  bloomKnee: number;
}

export class BloomQualityConfigProvider {
  private static readonly configs: Record<'low' | 'medium' | 'high', BloomQualityConfig> = {
    low: {
      enabled: true,
      maxBlurSteps: 2,
      blurStrength: 1.0,
      blendIntensity: 0.6,
      bloomIntensity: 0.8,
      bloomThreshold: 1.5,
      bloomRadius: 1.0,
      bloomKnee: 0.3,
    },
    medium: {
      enabled: true,
      maxBlurSteps: 4,
      blurStrength: 1.5,
      blendIntensity: 1.0,
      bloomIntensity: 1.0,
      bloomThreshold: 1.0,
      bloomRadius: 1.5,
      bloomKnee: 0.5,
    },
    high: {
      enabled: true,
      maxBlurSteps: 6,
      blurStrength: 2.0,
      blendIntensity: 1.2,
      bloomIntensity: 1.2,
      bloomThreshold: 0.8,
      bloomRadius: 2.0,
      bloomKnee: 0.7,
    },
  };

  public static getConfig(quality: 'low' | 'medium' | 'high'): BloomQualityConfig {
    return { ...this.configs[quality] };
  }

  public static getDisabledConfig(): BloomQualityConfig {
    return {
      enabled: false,
      maxBlurSteps: 1,
      blurStrength: 1.0,
      blendIntensity: 0.0,
      bloomIntensity: 0.0,
      bloomThreshold: 10.0,
      bloomRadius: 1.0,
      bloomKnee: 0.0,
    };
  }
}
