export interface BloomQualityConfig {
  enabled: boolean;
  maxBlurSteps: number;
  blurStrength: number;
}

export class BloomQualityConfigProvider {
  private static readonly configs: Record<'low' | 'medium' | 'high', BloomQualityConfig> = {
    low: {
      enabled: true,
      maxBlurSteps: 1,
      blurStrength: 1.0,
    },
    medium: {
      enabled: true,
      maxBlurSteps: 2,
      blurStrength: 1.5,
    },
    high: {
      enabled: true,
      maxBlurSteps: 4,
      blurStrength: 2.0,
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
    };
  }
}
