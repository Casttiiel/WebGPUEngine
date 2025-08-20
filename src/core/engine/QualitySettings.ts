import { AmbientOcclusionQualityConfig } from '../../renderer/core/config/AmbientOcclusionQualityConfig';
import { BloomQualityConfigProvider } from '../../renderer/core/config/BloomQualityConfig';
import { PostProcessingQualityConfig } from '../../renderer/core/config/PostProcessingQualityConfig';

export interface GraphicsQualitySettings {
  renderResolution: number;
  aliasingTexture: GPUTextureFormat;
  toneMappingTexture: GPUTextureFormat;
  bloomTexture: GPUTextureFormat;
  enableBloom: boolean;
  bloomNumMips: number;

  msaaLevel: number; // 1, 4
  ambientOcclusionQuality: 'off' | 'low' | 'medium' | 'high';
  gBufferTextureQuality: 'low' | 'medium' | 'high';
}

export class QualitySettings {
  private static instance: QualitySettings | null = null;
  private settings: GraphicsQualitySettings | undefined;
  private currentPreset: keyof typeof QualitySettings.PRESETS = 'ULTRA';

  // Predefined quality presets
  public static readonly PRESETS = {
    LOW: {
      renderResolution: 0.75,
      aliasingTexture: 'rgba16float', // Used
      toneMappingTexture: 'rgba16float', // Used
      bloomTexture: 'rgba16float', // Used
      enableBloom: false, // Used
      bloomNumMips: 0, // Used
      msaaLevel: 1,
      ambientOcclusionQuality: 'low',
      gBufferTextureQuality: 'low',
    } as GraphicsQualitySettings,

    MEDIUM: {
      renderResolution: 0.85,
      aliasingTexture: 'rgba16float', // Used
      toneMappingTexture: 'rgba16float', // Used
      bloomTexture: 'rgba16float', // Used
      enableBloom: true, // Used
      bloomNumMips: 3, // Used
      msaaLevel: 4,
      ambientOcclusionQuality: 'medium',
      gBufferTextureQuality: 'medium',
    } as GraphicsQualitySettings,

    HIGH: {
      renderResolution: 1.0,
      aliasingTexture: 'rgba16float', // Used
      toneMappingTexture: 'rgba16float', // Used
      bloomTexture: 'rgba16float', // Used
      enableBloom: true, // Used
      bloomNumMips: 6, // Used
      msaaLevel: 4,
      ambientOcclusionQuality: 'high',
      gBufferTextureQuality: 'high',
    } as GraphicsQualitySettings,

    ULTRA: {
      renderResolution: 1.0, // Used
      aliasingTexture: 'rgba16float', // Used
      toneMappingTexture: 'rgba16float', // Used
      bloomTexture: 'rgba16float', // Used
      enableBloom: true, // Used
      bloomNumMips: 8, // Used
      msaaLevel: 4,
      ambientOcclusionQuality: 'high',
      gBufferTextureQuality: 'high',
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

  public updateSettings(newSettings: Partial<GraphicsQualitySettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    // Mark as custom when individual settings are changed
    this.currentPreset = 'CUSTOM' as any;
    this.onSettingsChanged();
  }

  public applyPreset(presetName: keyof typeof QualitySettings.PRESETS): void {
    console.log(`Applied ${presetName} quality preset`);

    this.currentPreset = presetName;
    this.settings = { ...QualitySettings.PRESETS[presetName] };
    this.onSettingsChanged();
  }

  public getRenderResolution(): number {
    return this.settings.renderResolution;
  }

  public getMSAALevel(): number {
    return this.settings.msaaLevel;
  }

  public getGBufferTextureQuality(): 'low' | 'medium' | 'high' {
    return this.settings.gBufferTextureQuality;
  }

  public getAmbientOcclusionConfig() {
    return AmbientOcclusionQualityConfig.getConfig('high');
  }

  public getPostProcessingFormats() {
    return PostProcessingQualityConfig.getFormats('high');
  }

  public getBloomConfig() {
    return BloomQualityConfigProvider.getConfig('high');
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
