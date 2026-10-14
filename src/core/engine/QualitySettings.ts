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
  /** AO samples (three.js GTAO/SSAO `samples`, 4..32). */
  aoSampleCount: number;
  albedoTexture: GPUTextureFormat;
  normalTexture: GPUTextureFormat;
  linearDepthTexture: GPUTextureFormat;
  generalTexture: GPUTextureFormat;
  hdrTexture: GPUTextureFormat;
  ssrEnabled: boolean;
  ssrScale: number;
  directionalShadowMapResolution: number;
  useKTX2: boolean;
  meshTextureFilter: 'trilinear' | 'nearest';
  ditheringMode: 'off' | 'psx';
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
      aoSampleCount: 8,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: false,
      ssrScale: 0.4,
      directionalShadowMapResolution: 256,

      enableMotionBlur: false,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
      ditheringMode: 'off',
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
      aoSampleCount: 8,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.4,
      directionalShadowMapResolution: 512,

      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
      ditheringMode: 'off',
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
      aoSampleCount: 16,
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
      directionalShadowMapResolution: 1024,

      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
      ditheringMode: 'off',
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
      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba16float',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.5,
      directionalShadowMapResolution: 2048,

      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
      ditheringMode: 'off',
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

  /** Merged defaults+settings, rebuilt only when settings change (read every frame). */
  private mergedSettings: GraphicsQualitySettings | null = null;

  /** Returns a shared, read-only object — do not mutate it. */
  public getSettings(): GraphicsQualitySettings {
    if (this.mergedSettings) return this.mergedSettings;
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

      albedoTexture: 'rgba8unorm',
      normalTexture: 'rgba8unorm',
      linearDepthTexture: 'r16float',
      generalTexture: 'rgba8unorm',
      hdrTexture: 'rgba16float',
      ssrEnabled: true,
      ssrScale: 0.75,
      directionalShadowMapResolution: 2048,
      enableMotionBlur: true,
      useKTX2: false,
      meshTextureFilter: 'trilinear',
      ditheringMode: 'off',
    };
    this.mergedSettings = { ...defaults, ...this.settings };
    return this.mergedSettings;
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
    this.mergedSettings = null;
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
      this.mergedSettings = null;
    }
    this.currentPreset = 'CUSTOM' as any;
  }

  public setMeshTextureFilter(value: 'trilinear' | 'nearest'): void {
    if (this.settings) {
      this.settings.meshTextureFilter = value;
      this.mergedSettings = null;
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
