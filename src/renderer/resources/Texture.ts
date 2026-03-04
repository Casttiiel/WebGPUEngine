import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { KTX2Loader, KTX2TextureData } from './KTX2Loader';

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

  // Prevents returning a registered-but-not-yet-loaded texture to concurrent callers.
  private static readonly inflight = new Map<string, Promise<Texture>>();

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
    // 1. Fully loaded and registered — return immediately.
    try {
      const t = ResourceManager.getResource<Texture>(path);
      // Only return if the texture view is actually ready (fully loaded).
      if (t.getTextureView()) return t;
    } catch {
      // not registered yet
    }

    // 2. Another concurrent call is already loading this texture — share its promise.
    const existing = this.inflight.get(path);
    if (existing) return existing;

    // 3. First caller: create, register, and store the in-flight promise before any await.
    const texture = new Texture({ path, type: ResourceType.TEXTURE });
    ResourceManager.registerResource(texture);

    const promise = texture.loadAsync().then(() => {
      this.inflight.delete(path);
      return texture;
    });

    this.inflight.set(path, promise);
    return promise;
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
    const _t0 = performance.now();

    // ── Try KTX2 compressed format first ─────────────────────────────────────
    // ktx2PathFor() swaps the extension, e.g. "diffuse.png" / "diffuse.webp" → "diffuse.ktx2".
    // ResourceManager.fetch throws on 404, so we catch silently and fall through
    // to the PNG/WebP path when the .ktx2 file does not exist yet.
    const ktx2Path = KTX2Loader.ktx2PathFor(this.path);
    try {
      const resp = await ResourceManager.fetch(`assets/textures/${ktx2Path}`);
      const buffer = await resp.arrayBuffer();
      const ktx2 = await KTX2Loader.decode(buffer);
      this.uploadKTX2(ktx2);
      const ms = (performance.now() - _t0).toFixed(0);
      if (+ms > 30) console.log(`%c[Texture/KTX2] ${ktx2Path}  total=${ms}ms`, 'color:#4caf50');
      return;
    } catch (e) {
      // .ktx2 not present or transcode error — fall through to PNG / WebP.
      // Log only once per path to avoid console spam on legitimate 404s.
      if (e instanceof Error && !e.message.includes('404') && !(e as Error & { logged?: boolean }).logged) {
        (e as Error & { logged?: boolean }).logged = true;
        console.warn(`[Texture/KTX2] fallback for ${this.path}:`, e.message);
      }
    }

    // ── PNG / WebP fallback ───────────────────────────────────────────────────
    const response = await ResourceManager.fetch(`assets/textures/${this.path}`);
    const blob = await response.blob();
    const _tDecode = performance.now();
    const imageBitmap = await createImageBitmap(blob);
    const _decodeMs = performance.now() - _tDecode;
    const _totalMs = performance.now() - _t0;
    if (_totalMs > 30) {
      console.log(
        `%c[Texture] ${this.path}  decode=${_decodeMs.toFixed(0)}ms  total=${_totalMs.toFixed(0)}ms`,
        'color:#ff9800',
      );
    }
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
    );

    // Copy image data
    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.texture },
      { width: imageBitmap.width, height: imageBitmap.height },
    );

    // Generate mipmaps if needed
    if (this.genMipmaps) {
      const _tMip = performance.now();
      await this.generateMipmaps();
      const _mipMs = performance.now() - _tMip;
      if (_mipMs > 30) {
        console.log(
          `%c[Texture] ${this.path}  generateMipmaps waited=${_mipMs.toFixed(0)}ms`,
          'color:#ff9800',
        );
      }
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

  /**
   * Upload pre-transcoded KTX2 mip levels directly to the GPU.
   *
   * Block-compressed formats (BC7) do NOT support RENDER_ATTACHMENT or
   * STORAGE_BINDING, so the usage flags are narrowed automatically when the
   * data is compressed.  The caller therefore never needs to know whether it
   * received a compressed or uncompressed decode result.
   */
  private uploadKTX2(ktx2: KTX2TextureData): void {
    const { mipLevels, format, isCompressed, blockByteSize, blockDim } = ktx2;
    const { width, height } = mipLevels[0]!;
    const mipLevelCount = mipLevels.length;

    // BC7 and other block-compressed formats cannot have RENDER_ATTACHMENT
    // or STORAGE_BINDING — restrict to TEXTURE_BINDING | COPY_DST.
    const safeUsage = isCompressed
      ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      : this.usage;

    this.texture = GPUUtils.createTextureWithMipmaps(
      `${this.label}_texture`,
      width,
      height,
      format,
      safeUsage,
      mipLevelCount,
    );

    for (let level = 0; level < mipLevels.length; level++) {
      const mip = mipLevels[level]!;
      const blocksX = Math.ceil(mip.width / blockDim);
      const blocksY = Math.ceil(mip.height / blockDim);
      const bytesPerRow = blocksX * blockByteSize;

      // For block-compressed formats the copy extent width/height must be
      // multiples of the block dimension.  Mip levels smaller than blockDim
      // (e.g. 2×2 or 1×1 with BC7 blockDim=4) must be padded up to blockDim,
      // while the transcoder already produced exactly blocksX*blocksY blocks.
      const copyWidth  = isCompressed ? blocksX * blockDim : mip.width;
      const copyHeight = isCompressed ? blocksY * blockDim : mip.height;

      this.device.queue.writeTexture(
        { texture: this.texture, mipLevel: level },
        mip.data,
        { bytesPerRow, rowsPerImage: blocksY },
        { width: copyWidth, height: copyHeight },
      );
    }

    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      baseMipLevel: 0,
      mipLevelCount,
    });

    this.sampler = SamplerLibrary.anisotropic16x;
    this.setHasData();
  }

  public getTextureView(): GPUTextureView | undefined {
    return this.textureView;
  }

  public getTexture(): GPUTexture | undefined {
    return this.texture;
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
