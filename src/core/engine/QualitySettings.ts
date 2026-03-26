export interface GraphicsQualitySettings {
  renderResolution: number;
  aliasingTexture: GPUTextureFormat;
  toneMappingTexture: GPUTextureFormat;
  bloomTexture: GPUTextureFormat;
  enableBloom: boolean;
  enableMotionBlur: boolean;
  bloomNumMips: number;
  enableAO: boolean;
  aoScale: number;
  aoTexture: GPUTextureFormat;
  aoSampleCount: number;
  aoRadius: number;
  aoStrength: number;
  aoSliceCount: number;
  albedoTexture: GPUTextureFormat;
  normalTexture: GPUTextureFormat;
  linearDepthTexture: GPUTextureFormat;
  generalTexture: GPUTextureFormat;
  hdrTexture: GPUTextureFormat;
  ssrEnabled: boolean;
  ssrScale: number;
  ssrStepSize: number;
  ssrMaxSteps: number;
  directionalShadowMapResolution: number;
  ssgiScale: number;
  useKTX2: boolean;
  meshTextureFilter: 'trilinear' | 'nearest';
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
      aoScale: 0.25,
      aoTexture: 'r16float',
      aoSampleCount: 2.0,
      aoRadius: 5.0,
      aoStrength: 1.0,
      aoSliceCount: 2.0,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: false,
      ssrScale: 0.4,
      ssrStepSize: 0.3,
      ssrMaxSteps: 48.0,
      directionalShadowMapResolution: 256,
      ssgiScale: 0.25,
      enableMotionBlur: false,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
    } as GraphicsQualitySettings,

    MEDIUM: {
      renderResolution: 0.8,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: true,
      bloomNumMips: 3,
      enableAO: true,
      aoScale: 0.25,
      aoTexture: 'r16float',
      aoSampleCount: 4.0,
      aoRadius: 5.0,
      aoStrength: 1.0,
      aoSliceCount: 2.0,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.4,
      ssrStepSize: 0.3,
      ssrMaxSteps: 48.0,
      directionalShadowMapResolution: 512,
      ssgiScale: 0.25,
      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
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
      aoSampleCount: 8.0,
      aoRadius: 5.0,
      aoStrength: 1.0,
      aoSliceCount: 3.0,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
      ssrStepSize: 0.3,
      ssrMaxSteps: 48.0,
      directionalShadowMapResolution: 1024,
      ssgiScale: 0.25,
      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
    } as GraphicsQualitySettings,

    ULTRA: {
      renderResolution: 1.0,
      aliasingTexture: 'rgba16float',
      toneMappingTexture: 'rgba16float',
      bloomTexture: 'rgba16float',
      enableBloom: true,
      bloomNumMips: 8,
      enableAO: false,
      aoScale: 0.5,
      aoTexture: 'r16float',
      aoSampleCount: 8.0,
      aoRadius: 1.5,
      aoStrength: 1.0,
      aoSliceCount: 6.0,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
      ssrStepSize: 0.3,
      ssrMaxSteps: 48.0,
      directionalShadowMapResolution: 4096,
      ssgiScale: 0.25,
      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
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
    // Ensure all required fields are present for GraphicsQualitySettings
    const defaults: GraphicsQualitySettings = {
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
      aoSliceCount: 0.01,
      ssgiScale: 0.25,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.75,
      ssrStepSize: 0.05,
      ssrMaxSteps: 640.0,
      directionalShadowMapResolution: 2048,
      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
    };
    return { ...defaults, ...this.settings };
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
    this.currentPreset = presetName;
    this.settings = { ...QualitySettings.PRESETS[presetName] };
    this.onSettingsChanged();
  }

  /**
   * Override only the render resolution scale (0.1 – 1.0) without changing
   * any other quality settings.  Callers must follow with
   * Render.applyRenderResolution() to propagate the change to GPU resources.
   */
  public setRenderResolution(value: number): void {
    const clamped = Math.min(1.0, Math.max(0.1, value));
    if (this.settings) {
      this.settings.renderResolution = clamped;
    }
    this.currentPreset = 'CUSTOM' as any;
  }

  public setMeshTextureFilter(value: 'trilinear' | 'nearest'): void {
    if (this.settings) {
      this.settings.meshTextureFilter = value;
    }
  }

  private onSettingsChanged(): void {
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
