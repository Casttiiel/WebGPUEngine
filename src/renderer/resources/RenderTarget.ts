import { GPUUtils } from '../core/utils/GPUUtils';
import { QualitySettings } from '../../core/engine/QualitySettings';

export class RenderTarget {
  private name: string = '';
  private xRes: number = 0;
  private yRes: number = 0;
  private texture!: GPUTexture;
  private textureView!: GPUTextureView | null;

  // MSAA support
  private msaaTexture!: GPUTexture; // Multi-sample texture (for rendering)
  private msaaTextureView!: GPUTextureView | null;
  private isMultisample: boolean = false;

  public createRT(
    name: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    multisampling = false,
    extraUsage = 0, // Additional usage flags
  ): void {
    this.destroy();

    this.name = name;
    this.xRes = width;
    this.yRes = height;
    this.isMultisample = multisampling;

    // Get MSAA level from quality settings
    const msaaLevel = multisampling ? QualitySettings.getInstance().getSettings().msaaLevel : 1;

    // Always create the single-sample texture (for shader sampling)
    // Always use both RENDER_ATTACHMENT and TEXTURE_BINDING for maximum flexibility
    const baseUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.texture = GPUUtils.createTexture(
      `${this.name}_resolve_texture`,
      width,
      height,
      format,
      baseUsage | extraUsage,
      1, // Always single-sample for shader access
    );

    // If MSAA enabled, create additional multi-sample texture
    if (multisampling && msaaLevel > 1) {
      this.msaaTexture = GPUUtils.createTexture(
        `${this.name}_msaa_texture`,
        width,
        height,
        format,
        GPUTextureUsage.RENDER_ATTACHMENT, // No TEXTURE_BINDING needed
        msaaLevel, // Use quality settings MSAA level
      );
    }
  }

  // Returns the view for shader sampling (always single-sample)
  public getView(): GPUTextureView {
    if (this.textureView) return this.textureView;
    this.textureView = this.texture.createView({
      label: `${this.name}_textureView`,
    });
    return this.textureView;
  }

  // Returns a storage texture view for compute shaders
  public getStorageView(): GPUTextureView {
    return this.texture.createView({
      label: `${this.name}_storageView`,
    });
  }

  // Returns the view for rendering (MSAA if enabled, otherwise single-sample)
  public getRenderView(): GPUTextureView {
    const msaaLevel = QualitySettings.getInstance().getSettings().msaaLevel;

    if (this.isMultisample && msaaLevel > 1) {
      if (this.msaaTextureView) return this.msaaTextureView;
      this.msaaTextureView = this.msaaTexture.createView({
        label: `${this.name}_msaa_textureView`,
      });
      return this.msaaTextureView;
    }
    // For non-MSAA or MSAA level 1, return the single texture view
    return this.getView();
  }

  // Returns the resolve target (only if MSAA is enabled)
  public getResolveTarget(): GPUTextureView | undefined {
    const msaaLevel = QualitySettings.getInstance().getSettings().msaaLevel;
    return this.isMultisample && msaaLevel > 1 ? this.getView() : undefined;
  }

  public getWidth(): number {
    return this.xRes;
  }

  public getHeight(): number {
    return this.yRes;
  }

  // Get the underlying texture for copying operations
  public getTexture(): GPUTexture {
    return this.texture;
  }

  public getName(): string {
    return this.name;
  }

  public destroy(): void {
    if (this.texture) {
      this.texture.destroy();
    }
    if (this.msaaTexture) {
      this.msaaTexture.destroy();
    }
    this.textureView = null;
    this.msaaTextureView = null;
  }
}
