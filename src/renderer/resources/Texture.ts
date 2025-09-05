import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';

export interface TextureOptions extends IGPUResourceOptions {
  genMipmaps?: boolean;
  format?: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
}

export class Texture extends GPUResource {
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private sampler?: GPUSampler;
  private genMipmaps: boolean;
  private format: GPUTextureFormat;
  private usage: GPUTextureUsageFlags;
  private static mipmapGenerator: MipmapGenerator | null = null;

  constructor(options: TextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
    this.genMipmaps = options.genMipmaps ?? true;

    // Use quality settings for texture format if not explicitly specified
    if (options.format) {
      this.format = options.format;
    } else {
      this.format = QualitySettings.getInstance().getSettings().generalTexture;
    }
    this.usage =
      options.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING;
  }

  public static get(path: string): Texture {
    // Check if texture is already registered
    try {
      return ResourceManager.getResource<Texture>(path);
    } catch {
      // Create new texture and register it before loading
      const texture = new Texture({ path, type: ResourceType.TEXTURE });

      // Register first to prevent race conditions
      ResourceManager.registerResource(texture);

      // Start loading without await (non-blocking)
      texture.load();

      return texture;
    }
  }

  public static async getAsync(path: string): Promise<Texture> {
    // Check if texture is already registered
    try {
      return ResourceManager.getResource<Texture>(path);
    } catch {
      // Create new texture and register it before loading
      const texture = new Texture({ path, type: ResourceType.TEXTURE });

      // Register first to prevent race conditions
      ResourceManager.registerResource(texture);

      // Then load the texture
      await texture.loadAsync();
      return texture;
    }
  }

  public async loadAsync(): Promise<void> {
    await this.createTexture();
  }

  public override load(): void {
    // Síncrono: inicia la carga sin await
    this.createTexture().catch((error) => {
      console.error(`Error loading texture ${this.path}:`, error);
    });
  }

  private async createTexture(): Promise<void> {
    // Load image
    const img = new Image();
    img.src = `assets/textures/${this.path}`;
    await img.decode();

    const imageBitmap = await createImageBitmap(img);
    const mipLevelCount = this.genMipmaps
      ? Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1
      : 1;

    // Create GPU texture
    this.texture = GPUUtils.createTextureWithMipmaps(
      `${this.label}_texture`,
      imageBitmap.width,
      imageBitmap.height,
      this.format,
      this.usage,
      mipLevelCount,
      1,
      1,
    );

    // Copy image data
    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.texture },
      { width: imageBitmap.width, height: imageBitmap.height },
    );

    // Generate mipmaps if needed
    if (this.genMipmaps) {
      await this.generateMipmaps();
    }

    // Create view and sampler
    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      baseMipLevel: 0,
      mipLevelCount,
    });

    this.sampler = SamplerLibrary.anisotropic16x;

    // Mark as loaded when createTexture completes
    this.setHasData();
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }

  public async generateMipmaps(): Promise<void> {
    await Texture.initMipmapGenerator();

    if (!this.texture) {
      throw new Error('Texture is not initialized.');
    }

    if (!Texture.mipmapGenerator) {
      throw new Error('MipmapGenerator is not initialized.');
    }

    const mipLevelCount = this.texture.mipLevelCount ?? 1;

    // Use the dynamic MipmapGenerator for 2D textures
    await Texture.mipmapGenerator.generateMipmapsFor2D(this.texture, mipLevelCount);
  }

  private static async initMipmapGenerator() {
    if (this.mipmapGenerator) return;

    this.mipmapGenerator = MipmapGenerator.getInstance();
    await this.mipmapGenerator.initialize();
  }

  /**
   * Clean up static resources
   */
  public static cleanup(): void {
    if (this.mipmapGenerator) {
      MipmapGenerator.destroyInstance();
      this.mipmapGenerator = null;
    }
  }
}
