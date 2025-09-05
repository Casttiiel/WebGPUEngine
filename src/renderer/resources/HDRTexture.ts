import { ResourceManager } from '../../core/engine/ResourceManager';
import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { decodeRGBE } from '@derschmale/io-rgbe';
import { Float16Array } from '@petamoriken/float16';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';

export interface HDRTextureOptions extends IGPUResourceOptions {
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  addressModeW?: GPUAddressMode;
  maxAnisotropy?: number;
}

export class HDRTexture extends GPUResource {
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private sampler?: GPUSampler;
  private static mipmapGenerator: MipmapGenerator | null = null;

  constructor(options: HDRTextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
  }

  public static get(path: string, options: Partial<HDRTextureOptions> = {}): HDRTexture {
    try {
      return ResourceManager.getResource<HDRTexture>(path);
    } catch {
      const texture = new HDRTexture({
        path,
        type: ResourceType.TEXTURE,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(texture);

      // Start loading without await (non-blocking)
      texture.load();

      return texture;
    }
  }

  public static async getAsync(
    path: string,
    options: Partial<HDRTextureOptions> = {},
  ): Promise<HDRTexture> {
    try {
      return ResourceManager.getResource<HDRTexture>(path);
    } catch {
      const texture = new HDRTexture({
        path,
        type: ResourceType.TEXTURE,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(texture);

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
      console.error(`Error loading HDR texture ${this.path}:`, error);
    });
  }

  private async createTexture(): Promise<void> {
    // 1. Descargar el archivo .hdr con tracking
    const resp = await ResourceManager.fetch(`assets/textures/${this.path}`);
    const buf = await resp.arrayBuffer();

    // 2. Decodificar usando io-rgbe
    const { width, height, data } = decodeRGBE(new DataView(buf)); // data = Float32Array RGB

    // 3. Convertir RGB -> RGBA (añadir alpha = 1.0)
    const pixelCount = data.length / 3;
    const tgt = new Float16Array(pixelCount * 4); // RGBA16 -> 4 componentes 16 bits
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      tgt[j] = data[i] ?? 0;
      tgt[j + 1] = data[i + 1] ?? 0;
      tgt[j + 2] = data[i + 2] ?? 0;
      tgt[j + 3] = 1.0;
    }

    // Calculate mip levels for HDR texture
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;

    // Create GPU texture with mipmaps
    this.texture = this.device.createTexture({
      label: `${this.label}_texture`,
      size: { width, height, depthOrArrayLayers: 1 },
      mipLevelCount: mipLevelCount,
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING,
    });

    // Upload the HDR data to mip level 0
    this.device.queue.writeTexture(
      { texture: this.texture, mipLevel: 0 },
      tgt.buffer,
      {
        offset: 0,
        bytesPerRow: width * 4 * 2, // 4 channels * 2 bytes per f16
        rowsPerImage: height,
      },
      { width, height, depthOrArrayLayers: 1 },
    );

    await this.generateMipmaps();

    // Create view and sampler AFTER mipmap generation
    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      format: 'rgba16float',
      mipLevelCount: this.texture.mipLevelCount,
    });

    this.sampler = SamplerLibrary.bloom;

    // Mark as loaded when createTexture completes
    this.setHasData();
  }

  public async generateMipmaps(): Promise<void> {
    await HDRTexture.initMipmapGenerator();

    if (!this.texture) {
      throw new Error('Texture is not initialized.');
    }

    if (!HDRTexture.mipmapGenerator) {
      throw new Error('MipmapGenerator is not initialized.');
    }

    const mipLevelCount = this.texture.mipLevelCount;

    // Use the MipmapGenerator for 2D textures
    await HDRTexture.mipmapGenerator.generateMipmapsFor2D(this.texture, mipLevelCount);
  }

  private static async initMipmapGenerator() {
    if (this.mipmapGenerator) return;

    this.mipmapGenerator = MipmapGenerator.getInstance();
    await this.mipmapGenerator.initialize();
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }
}
