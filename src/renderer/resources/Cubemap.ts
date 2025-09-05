import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';

export interface CubemapOptions extends IGPUResourceOptions {
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  addressModeW?: GPUAddressMode;
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

  constructor(options: CubemapOptions) {
    super({
      ...options,
      type: ResourceType.CUBEMAP,
    });

    this.magFilter = options.magFilter || 'linear';
    this.minFilter = options.minFilter || 'linear';
    this.mipmapFilter = options.mipmapFilter || 'linear';
    this.addressModeU = options.addressModeU || 'clamp-to-edge';
    this.addressModeV = options.addressModeV || 'clamp-to-edge';
    this.addressModeW = options.addressModeW || 'clamp-to-edge';
    this.maxAnisotropy = options.maxAnisotropy || 16;
  }

  public static get(path: string, options: Partial<CubemapOptions> = {}): Cubemap {
    try {
      return ResourceManager.getResource<Cubemap>(path);
    } catch {
      const cubemap = new Cubemap({
        path,
        type: ResourceType.CUBEMAP,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(cubemap);

      // Start loading without await (non-blocking)
      cubemap.load();

      return cubemap;
    }
  }

  public static async getAsync(
    path: string,
    options: Partial<CubemapOptions> = {},
  ): Promise<Cubemap> {
    try {
      return ResourceManager.getResource<Cubemap>(path);
    } catch {
      const cubemap = new Cubemap({
        path,
        type: ResourceType.CUBEMAP,
        ...options,
      });

      // Register first to prevent race conditions
      ResourceManager.registerResource(cubemap);

      await cubemap.loadAsync();
      return cubemap;
    }
  }

  public async loadAsync(): Promise<void> {
    try {
      const image = await createImageBitmap(
        await ResourceManager.fetch(`assets/textures/${this.path}`).then((r) => r.blob()),
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
      const mipLevelCount = Math.floor(Math.log2(Math.max(faceSize, faceSize))) + 1; // Crear la textura en GPU

      const skyboxFormat = QualitySettings.getInstance().getSettings().generalTexture;

      this.gpuTexture = GPUUtils.createCubemapTexture(
        `${this.label}_texture`,
        faceSize,
        skyboxFormat,
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.STORAGE_BINDING,
        mipLevelCount,
      );

      // Copiar cada cara al nivel 0 de mipmap
      for (let i = 0; i < 6; i++) {
        if (!faces[i]) {
          throw new Error(`Face image for index ${i} is undefined`);
        }
        this.device.queue.copyExternalImageToTexture(
          { source: faces[i] as ImageBitmap },
          {
            texture: this.gpuTexture,
            origin: { x: 0, y: 0, z: i },
            mipLevel: 0,
          },
          [faceSize, faceSize],
        );
      }

      // Generate mipmaps for the cubemap if more than 1 mip level
      if (mipLevelCount > 1) {
        const mipmapGenerator = MipmapGenerator.getInstance();
        await mipmapGenerator.initialize();
        await mipmapGenerator.generateMipmapsForCubemap(this.gpuTexture, mipLevelCount);
      }

      // Crear la vista de la textura
      this.gpuTextureView = this.gpuTexture.createView({
        label: `${this.label}_textureView`,
        dimension: 'cube',
        baseMipLevel: 0,
        mipLevelCount: mipLevelCount,
      });

      this.gpuSampler = GPUUtils.createSampler({
        label: `${this.label}_sampler`,
        magFilter: this.magFilter,
        minFilter: this.minFilter,
        mipmapFilter: this.mipmapFilter,
        addressModeU: this.addressModeU,
        addressModeV: this.addressModeV,
        addressModeW: this.addressModeW,
        maxAnisotropy: this.maxAnisotropy,
      });

      // Mark as loaded when loadAsync completes
      this.setHasData();
    } catch (error) {
      throw new Error(`Failed to create GPU resources for cubemap ${this.path}: ${error}`);
    }
  }

  public override load(): void {
    // Síncrono: inicia la carga sin await
    this.loadAsync().catch((error) => {
      console.error(`Error loading cubemap ${this.path}:`, error);
    });
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.gpuTextureView;
  }

  public getSampler(): GPUSampler | undefined {
    return this.gpuSampler;
  }
}
