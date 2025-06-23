import { Texture } from '../resources/Texture';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';

export class RenderToTexture {
  private baseTexture: Texture | null = null;  // Single-sample texture for shader sampling
  private msaaTexture: Texture | null = null;  // Multi-sample texture for rendering
  private width: number = 0;
  private height: number = 0;
  private isMultisample: boolean = false;

  public createRT(
    name: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    multisampling = false,
  ): void {
    this.destroy();

    this.width = width;
    this.height = height;
    this.isMultisample = multisampling;

    // Create base texture (single-sample)
    this.baseTexture = new Texture({
      label: `${name}_resolve`,
      path: `${name}_resolve`,
      type: ResourceType.TEXTURE,
      format,
      width,
      height,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      genMipmaps: false,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    
    ResourceManager.registerResource(this.baseTexture);
    void this.baseTexture.load();

    // Create MSAA texture if multisampling is enabled
    if (multisampling) {
      this.msaaTexture = new Texture({
        label: `${name}_msaa`,
        path: `${name}_msaa`,
        type: ResourceType.TEXTURE,
        format,
        width,
        height,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        genMipmaps: false,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        sampleCount: 4,
      });
      
      ResourceManager.registerResource(this.msaaTexture);
      void this.msaaTexture.load();
    }
  }

  /**
   * Returns the view for shader sampling (always single-sample)
   */
  public getView(): GPUTextureView {
    if (!this.baseTexture) {
      throw new Error('RenderToTexture not initialized');
    }
    return this.baseTexture.getTextureView();
  }

  /**
   * Returns the view for rendering (MSAA if enabled, otherwise single-sample)
   */
  public getRenderView(): GPUTextureView {
    if (this.isMultisample && this.msaaTexture) {
      return this.msaaTexture.getTextureView();
    }
    return this.getView(); // Use single-sample view if no MSAA
  }

  /**
   * Returns the resolve target (only if MSAA is enabled)
   */
  public getResolveTarget(): GPUTextureView | undefined {
    return this.isMultisample ? this.getView() : undefined;
  }

  public getWidth(): number {
    return this.width;
  }

  public getHeight(): number {
    return this.height;
  }
  public destroy(): void {
    if (this.baseTexture) {
      this.baseTexture.destroy();
      this.baseTexture = null;
    }
    if (this.msaaTexture) {
      this.msaaTexture.destroy();
      this.msaaTexture = null;
    }  }
}
