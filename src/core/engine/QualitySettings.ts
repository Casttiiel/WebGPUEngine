export interface GraphicsQualitySettings {
  renderResolution: number;
  aliasingTexture: GPUTextureFormat;
  toneMappingTexture: GPUTextureFormat;
  bloomTexture: GPUTextureFormat;
  enableBloom: boolean;
  bloomNumMips: number;
  enableAO: boolean;
  aoScale: number;
  aoTexture: GPUTextureFormat;
  aoSampleCount: number;
  aoRadius: number;
  aoStrength: number;
  aoNoiseScale: number;
  msaaLevel: number;
  albedoTexture: GPUTextureFormat;
  normalTexture: GPUTextureFormat;
  linearDepthTexture: GPUTextureFormat;
  generalTexture: GPUTextureFormat;
  hdrTexture: GPUTextureFormat;
  ssrEnabled: boolean;
  ssrScale: number;
}

export class QualitySettings {
  private static instance: QualitySettings | null = null;
  private settings: GraphicsQualitySettings | undefined;
  private currentPreset: keyof typeof QualitySettings.PRESETS = 'ULTRA';

  // Predefined quality presets
  public static readonly PRESETS = {
    LOW: {
      renderResolution: 0.8,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: false,
      bloomNumMips: 0,
      enableAO: false,
      aoScale: 0.5,
      aoTexture: 'r16float',
      aoSampleCount: 0,
      aoRadius: 0,
      aoStrength: 0,
      aoNoiseScale: 0,
      msaaLevel: 1,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: false,
      ssrScale: 0.5,
    } as GraphicsQualitySettings,

    MEDIUM: {
      renderResolution: 0.8,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: true,
      bloomNumMips: 3,
      enableAO: true,
      aoScale: 0.5,
      aoTexture: 'r16float',
      aoSampleCount: 8,
      aoRadius: 0.1,
      aoStrength: 3.0,
      aoNoiseScale: 0.01,
      msaaLevel: 4,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
    } as GraphicsQualitySettings,

    HIGH: {
      renderResolution: 0.9,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: true,
      bloomNumMips: 6,
      enableAO: true,
      aoScale: 0.5,
      aoTexture: 'r16float',
      aoSampleCount: 8,
      aoRadius: 0.1,
      aoStrength: 3.0,
      aoNoiseScale: 0.01,
      msaaLevel: 4,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
    } as GraphicsQualitySettings,

    ULTRA: {
      renderResolution: 1.0,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: true,
      bloomNumMips: 8,
      enableAO: true,
      aoScale: 0.5,
      aoTexture: 'r16float',
      aoSampleCount: 16,
      aoRadius: 0.1,
      aoStrength: 3.0,
      aoNoiseScale: 0.01,
      msaaLevel: 4,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
    } as GraphicsQualitySettings,
  };

  private constructor() {
    this.applyPreset('ULTRA');
  }

  public static getInstance(): QualitySettings {
    if (!QualitySettings.instance) {
      QualitySettings.instance = new QualitySettings();
    }
    return QualitySettings.instance;
  }

  public getSettings(): GraphicsQualitySettings {
    return { ...this.settings };
  }

  public getCurrentQualityName(): string {
    // If using a custom configuration, try to match against presets
    if (this.currentPreset === ('CUSTOM' as any)) {
      // Try to find if current settings match any preset
      for (const [presetName, presetSettings] of Object.entries(QualitySettings.PRESETS)) {
        const matches = Object.keys(presetSettings).every((key) => {
          return (this.settings as any)[key] === (presetSettings as any)[key];
        });
        if (matches) {
          this.currentPreset = presetName as keyof typeof QualitySettings.PRESETS;
          return presetName;
        }
      }
      return 'CUSTOM';
    }

    return this.currentPreset;
  }

  public applyPreset(presetName: keyof typeof QualitySettings.PRESETS): void {
    console.log(`Applied ${presetName} quality preset`);

    this.currentPreset = presetName;
    this.settings = { ...QualitySettings.PRESETS[presetName] };
    this.onSettingsChanged();
  }

  private onSettingsChanged(): void {
    // Emit event or trigger updates in renderer
    console.log('Graphics settings changed:', this.settings);

    // Dispatch a custom event that the engine can listen to
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('qualitySettingsChanged', {
        detail: {
          settings: { ...this.settings },
          // Include specific change types for optimized updates
          requiresPipelineRecreation: true,
          requiresRenderTargetRecreation: true,
        },
      });
      window.dispatchEvent(event);
    }
  }
}
