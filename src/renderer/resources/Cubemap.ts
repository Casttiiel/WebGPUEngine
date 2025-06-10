import { ResourceManager } from '../../core/engine/ResourceManager';
import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { CubemapDataType } from '../../types/CubemapData.type';

export interface CubemapOptions extends IGPUResourceOptions {
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  maxAnisotropy?: number;
}

export class Cubemap extends GPUResource {
  private gpuTexture?: GPUTexture;
  private gpuTextureView?: GPUTextureView;
  private gpuSampler?: GPUSampler;
  private magFilter: GPUFilterMode;
  private minFilter: GPUFilterMode;
  private mipmapFilter: GPUFilterMode;
  private addressModeU: GPUAddressMode;
  private addressModeV: GPUAddressMode;
  private addressModeW: GPUAddressMode;
  private maxAnisotropy: number;
  private faceSize: number;
  private mipLevelCount?: number;

  constructor(options: CubemapOptions) {
    super({
      ...options,
      type: ResourceType.CUBEMAP,
    });

    this.magFilter = options.magFilter || 'linear';
    this.minFilter = options.minFilter || 'linear';
    this.mipmapFilter = options.mipmapFilter || 'linear';
    this.addressModeU = options.addressModeU || 'repeat';
    this.addressModeV = options.addressModeV || 'repeat';
    this.maxAnisotropy = options.maxAnisotropy || 16;
  }

  public static async get(path: string, options: Partial<CubemapOptions> = {}): Promise<Cubemap> {
    try {
      return await ResourceManager.getResource<Cubemap>(path);
    } catch {
      const cubemap = new Cubemap({
        path,
        type: ResourceType.CUBEMAP,
        ...options,
      });
      await ResourceManager.registerResource(cubemap);
      return cubemap;
    }
  }
  protected async createGPUResources(): Promise<void> {
    try {
      const image = await createImageBitmap(
        await fetch(`/assets/textures/${this.path}`).then((r) => r.blob()),
      );

      const faceSize = image.width / 4; // Asumimos imagen 4x3 caras
      const faceCoords: Record<number, [number, number]> = {
        0: [2, 1], // +X
        1: [0, 1], // -X
        2: [1, 0], // +Y
        3: [1, 2], // -Y
        4: [1, 1], // +Z
        5: [3, 1], // -Z
      };

      const canvas = new OffscreenCanvas(faceSize, faceSize);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not get 2D context from canvas');
      }

      const faces: ImageBitmap[] = [];

      for (let i = 0; i < 6; i++) {
        const coords = faceCoords[i];
        if (!coords) {
          throw new Error(`Invalid face index: ${i}`);
        }
        const [col, row] = coords;

        ctx.clearRect(0, 0, faceSize, faceSize);
        ctx.drawImage(
          image,
          col * faceSize,
          row * faceSize,
          faceSize,
          faceSize,
          0,
          0,
          faceSize,
          faceSize,
        );
        const face = await createImageBitmap(canvas);
        faces.push(face);
      }

      // Calcular niveles de mipmap
      const mipLevelCount = Math.floor(Math.log2(Math.max(faceSize, faceSize))) + 1;

      // Crear la textura en GPU
      this.gpuTexture = this.device.createTexture({
        label: `${this.label}_texture`,
        size: [faceSize, faceSize, 6],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mipLevelCount,
      });

      // Copiar cada cara al nivel 0 de mipmap
      for (let i = 0; i < 6; i++) {
        this.device.queue.copyExternalImageToTexture(
          { source: faces[i] },
          {
            texture: this.gpuTexture,
            origin: { x: 0, y: 0, z: i },
            mipLevel: 0,
          },
          [faceSize, faceSize],
        );
      }

      // Crear la vista de la textura
      this.gpuTextureView = this.gpuTexture.createView({
        label: `${this.label}_textureView`,
        dimension: 'cube',
        baseMipLevel: 0,
        mipLevelCount: mipLevelCount,
      });

      // Crear el sampler
      this.gpuSampler = this.device.createSampler({
        label: `${this.label}_sampler`,
        magFilter: this.magFilter,
        minFilter: this.minFilter,
        mipmapFilter: this.mipmapFilter,
        addressModeU: this.addressModeU,
        addressModeV: this.addressModeV,
        maxAnisotropy: this.maxAnisotropy,
      });
    } catch (error) {
      throw new Error(`Failed to create GPU resources for cubemap ${this.path}: ${error}`);
    }
  }

  protected async destroyGPUResources(): Promise<void> {
    this.gpuTexture?.destroy();
    this.gpuTexture = undefined;
    this.gpuTextureView = undefined;
    this.gpuSampler = undefined;
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.gpuTextureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.gpuSampler;
  }
}
