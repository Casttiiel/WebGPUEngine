import { GPUUtils } from '../core/utils/GPUUtils';

export class RenderTarget {
  private name: string = '';
  private xRes: number = 0;
  private yRes: number = 0;
  private texture!: GPUTexture;
  private textureView!: GPUTextureView | null;

  public createRT(
    name: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    extraUsage = 0, // Additional usage flags
  ): void {
    this.destroy();

    this.name = name;
    this.xRes = width;
    this.yRes = height;

    // Create single-sample texture
    // Always use both RENDER_ATTACHMENT and TEXTURE_BINDING for maximum flexibility
    const baseUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.texture = GPUUtils.createTexture(
      this.name,
      width,
      height,
      format,
      baseUsage | extraUsage,
      1, // Single-sample only
    );
  }

  // Returns the view for shader sampling
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

  // Returns the view for rendering (same as getView, kept for compatibility)
  public getRenderView(): GPUTextureView {
    return this.getView();
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
    this.textureView = null;
  }
}
