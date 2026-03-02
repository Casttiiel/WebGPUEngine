import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { GPUUtils } from '../core/utils/GPUUtils';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { KTX2Loader } from './KTX2Loader';

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

  /** Set to true once the WASM transcoder has been confirmed to load successfully. */
  private static ktx2Available: boolean | null = null;

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
    // ── Try KTX2 first ────────────────────────────────────────────────────────
    if (Texture.ktx2Available !== false) {
      const ktx2Path = KTX2Loader.ktx2PathFor(this.path);
      if (ktx2Path !== this.path) {
        // only attempt if path actually changed
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}assets/textures/${ktx2Path}`);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            await this.createTextureFromKTX2(buffer);
            if (Texture.ktx2Available === null) {
              Texture.ktx2Available = true;
              console.log('[Texture] KTX2 compression active (BC7).');
            }
            return; // ✅ done — skip the uncompressed path below
          }
          // 404 → .ktx2 not generated yet, fall through silently
        } catch {
          // WASM load failed or parse error — disable KTX2 for this session
          if (Texture.ktx2Available === null) {
            Texture.ktx2Available = false;
            console.warn('[Texture] KTX2 loader unavailable, using uncompressed textures.');
          }
        }
      }
    }

    // ── Uncompressed fallback (PNG / JPG / WebP) ──────────────────────────────
    const _t0 = performance.now();

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

  private async createTextureFromKTX2(buffer: ArrayBuffer): Promise<void> {
    const ktx2 = await KTX2Loader.decode(buffer);

    const { mipLevels, format, isCompressed, blockByteSize, blockDim } = ktx2;
    if (!mipLevels.length) throw new Error('KTX2: no mip levels decoded');
    const { width, height } = mipLevels[0]!;
    const mipLevelCount = mipLevels.length;

    // BC7 can't be used as a render attachment or storage texture —
    // use TEXTURE_BINDING + COPY_DST only.
    const usage = isCompressed
      ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      : this.usage;

    this.texture = GPUUtils.createTextureWithMipmaps(
      `${this.label}_texture`,
      width,
      height,
      format,
      usage,
      mipLevelCount,
    );

    // Upload each mip level directly (no MipmapGenerator needed)
    for (let i = 0; i < mipLevels.length; i++) {
      const mip = mipLevels[i]!;
      const blocksX = Math.ceil(mip.width / blockDim);
      const blocksY = Math.ceil(mip.height / blockDim);
      this.device.queue.writeTexture(
        { texture: this.texture, mipLevel: i },
        mip.data,
        {
          bytesPerRow: blocksX * blockByteSize,
          rowsPerImage: blocksY,
        },
        { width: mip.width, height: mip.height },
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
