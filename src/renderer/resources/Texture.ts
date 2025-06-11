import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Render } from '../core/render';

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
  private static mipmapPipeline: GPUComputePipeline;
  private static mipmapBindGroupLayout: GPUBindGroupLayout;

  constructor(options: TextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
    this.genMipmaps = options.genMipmaps ?? true;
    this.format = options.format ?? 'rgba16float'; // rgba16float es filtrable y tiene suficiente precisión para HDR
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
    this.sampler = this.device.createSampler(samplerDescriptor);
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.sampler;
  }

  private async generateMipmapLevels(): Promise<void> {
    // Asegurarnos de que el pipeline está inicializado
    await Texture.initMipmapPipeline();

    const commandEncoder = this.device.createCommandEncoder();

    for (let level = 0; level < this.texture.mipLevelCount - 1; level++) {
      const srcView = this.texture.createView({
        baseMipLevel: level,
        mipLevelCount: 1,
      });

      const dstView = this.texture.createView({
        baseMipLevel: level + 1,
        mipLevelCount: 1,
      });

      const bindGroup = this.device.createBindGroup({
        layout: Texture.mipmapBindGroupLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: dstView },
        ],
      });

      const passEncoder = commandEncoder.beginComputePass();
      passEncoder.setPipeline(Texture.mipmapPipeline);
      passEncoder.setBindGroup(0, bindGroup);

      const width = Math.max(1, this.texture.width >> (level + 1));
      const height = Math.max(1, this.texture.height >> (level + 1));

      passEncoder.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));

      passEncoder.end();
    }

    this.device.queue.submit([commandEncoder.finish()]);
  }

  private static async initMipmapPipeline() {
    if (this.mipmapPipeline) return;

    const device = Render.getInstance().getDevice();
    const shaderModule = device.createShaderModule({
      label: 'Mipmap generation shader',
      code: await (await fetch('/assets/shaders/generate_mipmap.wgsl')).text(),
    });

    this.mipmapBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: {
            sampleType: 'float',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.mipmapBindGroupLayout],
    });

    this.mipmapPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });
  }
}
