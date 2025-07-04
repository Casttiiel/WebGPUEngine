import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';

export interface TextureOptions extends IGPUResourceOptions {
  genMipmaps?: boolean;
  format?: GPUTextureFormat;
  usage?: GPUTextureUsageFlags;
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUMipmapFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  maxAnisotropy?: number;
}

export class Texture extends GPUResource {
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private sampler?: GPUSampler;
  private genMipmaps: boolean;
  private format: GPUTextureFormat;
  private usage: GPUTextureUsageFlags;
  private magFilter: GPUFilterMode;
  private minFilter: GPUFilterMode;
  private mipmapFilter: GPUMipmapFilterMode;
  private addressModeU: GPUAddressMode;
  private addressModeV: GPUAddressMode;
  private maxAnisotropy: number;
  private static mipmapGenerator: MipmapGenerator;

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
      const qualitySettings = QualitySettings.getInstance();
      const postProcessingFormats = qualitySettings.getPostProcessingFormats();
      this.format = postProcessingFormats.skyboxTexture; // Use skybox format as default for general textures
    }

    this.usage =
      options.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING;
    this.magFilter = options.magFilter ?? 'linear';
    this.minFilter = options.minFilter ?? 'linear';
    this.mipmapFilter = options.mipmapFilter ?? 'linear';
    this.addressModeU = options.addressModeU ?? 'repeat';
    this.addressModeV = options.addressModeV ?? 'repeat';
    this.maxAnisotropy = options.maxAnisotropy ?? 16;
  }

  public static async get(path: string): Promise<Texture> {
    // Check if texture is already registered
    try {
      return ResourceManager.getResource<Texture>(path);
    } catch {
      // Create new texture and register it before loading
      const texture = new Texture({ path, type: ResourceType.TEXTURE });

      // Register first to prevent race conditions
      ResourceManager.registerResource(texture);

      // Then load the texture
      await texture.load();
      return texture;
    }
  }

  public async load(): Promise<void> {
    await this.createTexture();
  }

  private async createTexture(): Promise<void> {
    // Load image
    const img = new Image();
    img.src = `/assets/textures/${this.path}`;
    await img.decode();

    const imageBitmap = await createImageBitmap(img);
    const mipLevelCount = this.genMipmaps
      ? Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1
      : 1; // Create GPU texture
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
      await this.generateMipmapLevels();
    }

    // Create view and sampler
    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      baseMipLevel: 0,
      mipLevelCount,
    });

    const samplerDescriptor: GPUSamplerDescriptor = {
      label: `${this.label}_sampler`,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      addressModeU: this.addressModeU,
      addressModeV: this.addressModeV,
      maxAnisotropy: this.maxAnisotropy,
    };
    if (this.genMipmaps) {
      samplerDescriptor.mipmapFilter = this.mipmapFilter;
    }
    this.sampler = GPUUtils.createSampler(samplerDescriptor);
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }

  private async generateMipmapLevels(): Promise<void> {
    // Initialize mipmap generator if needed
    await Texture.initMipmapGenerator();

    if (!this.texture) {
      throw new Error('Texture is not initialized.');
    }

    const mipLevelCount = this.texture.mipLevelCount ?? 1;

    // Use the dynamic MipmapGenerator for 2D textures
    Texture.mipmapGenerator.generateMipmapsFor2D(this.texture, mipLevelCount);
  }

  private static async initMipmapGenerator() {
    if (this.mipmapGenerator) return;

    this.mipmapGenerator = new MipmapGenerator();
    await this.mipmapGenerator.initialize();
  }
}
