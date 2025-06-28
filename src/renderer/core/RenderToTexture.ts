import { Render } from './Render';

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
    this.isMultisample = multisampling;

    const device = Render.getInstance().getDevice();

    // Always create the single-sample texture (for shader sampling)
    this.texture = device.createTexture({
      label: `${this.name}_resolve_texture`,
      size: [width, height],
      format: format,
      sampleCount: 1, // Always single-sample for shader access
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // If MSAA enabled, create additional multi-sample texture
    if (multisampling) {
      this.msaaTexture = device.createTexture({
        label: `${this.name}_msaa_texture`,
        size: [width, height],
        format: format,
        sampleCount: 4, // Multi-sample for rendering
        usage: GPUTextureUsage.RENDER_ATTACHMENT, // No TEXTURE_BINDING needed
      });
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
    return this.getView(); // Use single-sample view if no MSAA
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
