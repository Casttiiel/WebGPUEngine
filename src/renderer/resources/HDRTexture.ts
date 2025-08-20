import { ResourceManager } from '../../core/engine/ResourceManager';
import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { GPUUtils } from '../core/utils/GPUUtils';
import { decodeRGBE } from '@derschmale/io-rgbe';
import { Float16Array } from '@petamoriken/float16';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';

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

  constructor(options: HDRTextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
  }

  public static async get(
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
      await texture.load();
      ResourceManager.registerResource(texture);
      return texture;
    }
  }

  public async load(): Promise<void> {
    await this.createTexture();
  }

  private async createTexture(): Promise<void> {
    // 1. Descargar el archivo .hdr
    const resp = await fetch(`/assets/textures/${this.path}`);
    const buf = await resp.arrayBuffer();

    // 2. Decodificar usando io-rgbe
    const { width, height, data } = decodeRGBE(new DataView(buf)); // data = Float32Array RGB

    // 3. Convertir RGB -> RGBA (añadir alpha = 1.0)
    const pixelCount = data.length / 3;
    const tgt = new Float16Array(pixelCount * 4); // RGBA16 -> 4 componentes 16 bits
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      tgt[j] = data[i];
      tgt[j + 1] = data[i + 1];
      tgt[j + 2] = data[i + 2];
      tgt[j + 3] = 1.0;
    }

    // Create GPU texture
    this.texture = GPUUtils.createTexture(
      `${this.label}_texture`,
      width,
      height,
      'rgba16float',
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    );

    this.device.queue.writeTexture(
      { texture: this.texture },
      tgt.buffer,
      {
        offset: 0,
        bytesPerRow: width * 4 * 2,
        rowsPerImage: height,
      },
      { width, height, depthOrArrayLayers: 1 },
    );
    // Create view and sampler
    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
    });

    this.sampler = SamplerLibrary.bloom;
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }
}
