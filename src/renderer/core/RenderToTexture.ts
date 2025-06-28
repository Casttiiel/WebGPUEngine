import { GPUUtils } from './utils/GPUUtils';

export class RenderToTexture {
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
  ): void {
    this.destroy();

    this.name = name;
    this.xRes = width;
    this.yRes = height;
    this.isMultisample = multisampling;    // Always create the single-sample texture (for shader sampling)
    // Always use both RENDER_ATTACHMENT and TEXTURE_BINDING for maximum flexibility
    this.texture = GPUUtils.createTexture(
      `${this.name}_resolve_texture`,
      width,
      height,
      format,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      1 // Always single-sample for shader access
    );

    // If MSAA enabled, create additional multi-sample texture
    if (multisampling) {
      this.msaaTexture = GPUUtils.createTexture(
        `${this.name}_msaa_texture`,
        width,
        height,
        format,
        GPUTextureUsage.RENDER_ATTACHMENT, // No TEXTURE_BINDING needed
        4 // Multi-sample for rendering
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
  // Returns the view for rendering (MSAA if enabled, otherwise single-sample)
  public getRenderView(): GPUTextureView {
    if (this.isMultisample) {
      if (this.msaaTextureView) return this.msaaTextureView;
      this.msaaTextureView = this.msaaTexture.createView({
        label: `${this.name}_msaa_textureView`,
      });
      return this.msaaTextureView;
    }
    // For non-MSAA, return the single texture view (which has RENDER_ATTACHMENT usage)
    return this.getView();
  }

  // Returns the resolve target (only if MSAA is enabled)
  public getResolveTarget(): GPUTextureView | undefined {
    return this.isMultisample ? this.getView() : undefined;
  }

  public getWidth(): number {
    return this.xRes;
  }

  public getHeight(): number {
    return this.yRes;
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
