import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { CubemapDataType } from '../../types/CubemapData.type';

export interface TextureOptions extends IGPUResourceOptions {
  cubemapData?: CubemapDataType;
  isCubemap?: boolean;
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
  private isCubemap: boolean;
  private cubemapData?: CubemapDataType;
  private genMipmaps: boolean;
  private format: GPUTextureFormat;
  private usage: GPUTextureUsageFlags;
  private magFilter: GPUFilterMode;
  private minFilter: GPUFilterMode;
  private mipmapFilter: GPUMipmapFilterMode;
  private addressModeU: GPUAddressMode;
  private addressModeV: GPUAddressMode;
  private maxAnisotropy: number;

  constructor(options: TextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
    this.isCubemap = options.isCubemap ?? false;
    this.cubemapData = options.cubemapData;
    this.genMipmaps = options.genMipmaps ?? false;
    this.format = options.format ?? 'rgba8unorm';
    this.usage =
      options.usage ??
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;
    this.magFilter = options.magFilter ?? 'linear';
    this.minFilter = options.minFilter ?? 'linear';
    this.mipmapFilter = options.mipmapFilter ?? 'linear';
    this.addressModeU = options.addressModeU ?? 'repeat';
    this.addressModeV = options.addressModeV ?? 'repeat';
    this.maxAnisotropy = options.maxAnisotropy ?? 1;
  }

  protected async createGPUResources(): Promise<void> {
    if (this.isCubemap && this.cubemapData) {
      await this.createCubemapTexture();
    } else {
      await this.createRegularTexture();
    }
  }

  private async createCubemapTexture(): Promise<void> {
    if (!this.cubemapData) throw new Error('No cubemap data provided');

    const { faceSize, faces, format, mipLevelCount, dimension } = this.cubemapData;

    this.texture = this.device.createTexture({
      size: [faceSize, faceSize, 6], // width, height, and 6 faces
      dimension: dimension || '2d',
      format: format || 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: mipLevelCount || 1,
    });

    // Copy each face
    for (let face = 0; face < faces.length; face++) {
      this.device.queue.copyExternalImageToTexture(
        { source: faces[face] },
        { texture: this.texture, origin: [0, 0, face] },
        [faceSize, faceSize],
      );
    }

    // Create view
    this.textureView = this.texture.createView({
      dimension: 'cube',
      aspect: 'all',
    });

    // Create sampler
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
  }

  private async createRegularTexture(): Promise<void> {
    // Load image
    const img = new Image();
    // Si la ruta ya empieza con /assets, usarla como está
    img.src = this.path.startsWith('/assets/') ? this.path : `/assets/textures/${this.path}`;
    await img.decode();

    const imageBitmap = await createImageBitmap(img);
    const mipLevelCount = this.genMipmaps
      ? Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1
      : 1;

    // Create GPU texture
    this.texture = this.device.createTexture({
      label: `${this.label}_texture`,
      size: {
        width: imageBitmap.width,
        height: imageBitmap.height,
        depthOrArrayLayers: 1,
      },
      format: this.format,
      usage: this.usage,
      mipLevelCount,
    });

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

    this.sampler = this.device.createSampler({
      label: `${this.label}_sampler`,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      mipmapFilter: this.genMipmaps ? this.mipmapFilter : undefined,
      addressModeU: this.addressModeU,
      addressModeV: this.addressModeV,
      maxAnisotropy: this.maxAnisotropy,
    });
  }

  public static async get(pathOrData: string | CubemapDataType): Promise<Texture> {
    const path =
      typeof pathOrData === 'string' ? pathOrData : `dynamic_texture_${this.generateDynamicId()}`;

    // Check if texture is already registered
    try {
      const existingTexture = await ResourceManager.getResource<Texture>(path);
      if (existingTexture) {
        return existingTexture;
      }
    } catch {
      // Texture not registered yet, continue with creation
    }

    // Create new texture and register it before loading
    const texture =
      typeof pathOrData === 'string'
        ? new Texture({ path, type: ResourceType.TEXTURE })
        : new Texture({
            path,
            type: ResourceType.TEXTURE,
            cubemapData: pathOrData,
            isCubemap: true,
          });

    // Register first to prevent race conditions
    await ResourceManager.registerResource(texture);

    // Then load the texture
    await texture.load();
    return texture;
  }

  private static idCounter = 0;
  private static generateDynamicId(): string {
    return (++this.idCounter).toString().padStart(6, '0');
  }

  public isCubemapTexture(): boolean {
    return this.isCubemap;
  }

  public getCubemapData(): CubemapDataType | undefined {
    return this.cubemapData;
  }

  protected override async destroyGPUResources(): Promise<void> {
    this.texture?.destroy();
    this.texture = undefined;
    this.textureView = undefined;
    this.sampler = undefined;
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }

  private async generateMipmapLevels(): Promise<void> {
    // Implementation for mipmap generation would go here
    // This is a placeholder that should be implemented based on your engine's requirements
    console.warn('Mipmap generation not implemented yet');
  }
}
