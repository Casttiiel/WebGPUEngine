import { PostProcessingQualityConfig } from '../../renderer/core/PostProcessingQualityConfig';

export interface GraphicsQualitySettings {
  renderResolution: number; // 0.5 = 50%, 1.0 = 100%
  msaaLevel: number; // 1, 4
  ambientOcclusionQuality: 'off' | 'low' | 'medium' | 'high';
  gBufferTextureQuality: 'low' | 'medium' | 'high';
  postProcessingQuality: 'low' | 'medium' | 'high'; // For post-processing texture formats
  aliasingQuality: 'none' | 'fxaa' | 'msaa' | 'taa';
  cullingMode: 'cpu' | 'gpu' | 'hybrid';
  enableBloom: boolean;
  // Future: shadowQuality, anisotropicFiltering
}

export class QualitySettings {
  private static instance: QualitySettings | null = null;
  private settings: GraphicsQualitySettings;

  // Predefined quality presets
  public static readonly PRESETS = {
    MINIMUM: {
      renderResolution: 0.5,
      msaaLevel: 1,
      ambientOcclusionQuality: 'off',
      gBufferTextureQuality: 'low',
      postProcessingQuality: 'low',
      aliasingQuality: 'none',
      cullingMode: 'cpu',
      enableBloom: false,
    } as GraphicsQualitySettings,

    LOW: {
      renderResolution: 0.75,
      msaaLevel: 1,
      ambientOcclusionQuality: 'low',
      gBufferTextureQuality: 'low',
      postProcessingQuality: 'low',
      aliasingQuality: 'fxaa',
      cullingMode: 'cpu',
      enableBloom: false,
    } as GraphicsQualitySettings,

    MEDIUM: {
      renderResolution: 0.85,
      msaaLevel: 4,
      ambientOcclusionQuality: 'medium',
      gBufferTextureQuality: 'medium',
      postProcessingQuality: 'medium',
      aliasingQuality: 'fxaa',
      cullingMode: 'gpu',
      enableBloom: true,
    } as GraphicsQualitySettings,

    HIGH: {
      renderResolution: 1.0,
      msaaLevel: 4,
      ambientOcclusionQuality: 'high',
      gBufferTextureQuality: 'high',
      postProcessingQuality: 'high',
      aliasingQuality: 'msaa',
      cullingMode: 'gpu',
      enableBloom: true,
    } as GraphicsQualitySettings,

    ULTRA: {
      renderResolution: 1.0,
      msaaLevel: 4,
      ambientOcclusionQuality: 'high',
      gBufferTextureQuality: 'high',
      postProcessingQuality: 'high',
      aliasingQuality: 'taa',
      cullingMode: 'gpu',
      enableBloom: true,
    } as GraphicsQualitySettings,
  };

  private constructor() {
    // Start with medium settings
    this.settings = { ...QualitySettings.PRESETS.MEDIUM };
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

  public updateSettings(newSettings: Partial<GraphicsQualitySettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.onSettingsChanged();
  }

  public applyPreset(presetName: keyof typeof QualitySettings.PRESETS): void {
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


  public getPostProcessingFormats() {
    return PostProcessingQualityConfig.getFormats(this.settings.postProcessingQuality);
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
          requiresRenderTargetRecreation: true
        }
      });
      window.dispatchEvent(event);
    }
  }
}
