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
  isNormalMap?: boolean;
}

export class Texture extends GPUResource {
  private texture?: GPUTexture;
  private textureView?: GPUTextureView;
  private sampler?: GPUSampler;
  private genMipmaps: boolean;
  private format: GPUTextureFormat;
  private usage: GPUTextureUsageFlags;
  private isNormalMap: boolean;
  private static mipmapGenerator: MipmapGenerator | null = null;

  // Prevents returning a registered-but-not-yet-loaded texture to concurrent callers.
  private static readonly inflight = new Map<string, Promise<Texture>>();

  /**
   * Streaming state — non-null when the texture was initially loaded at a reduced resolution
   * (coarsest mips only) and is waiting for a full-resolution upgrade.
   */
  public streamingState: { isFullyLoaded: boolean; fullWidth: number; fullHeight: number } | null =
    null;

  /** True while streamFullResolution() is executing; prevents duplicate calls. */
  private upgradePending = false;

  /** Subscribers notified after the GPU texture view is replaced (e.g., after streaming). */
  private readonly viewListeners = new Set<() => void>();

  /**
   * GPU textures superseded by a streaming upgrade, queued for destruction at the start of the
   * next frame. Destroyed by flushPendingDestroys(), which is called by
   * TextureStreamingManager.update() before any command-buffer recording begins. Deferring
   * ensures that all device.queue.submit() calls referencing the old texture (via old bind
   * groups) have already happened before the resource is freed — eliminating the
   * "Destroyed texture used in a submit" validation error.
   */
  private static readonly pendingDestroy: GPUTexture[] = [];

  /** Enqueue an old GPU texture for deferred destruction (called from streamFullResolution). */
  public static deferDestroy(texture: GPUTexture): void {
    Texture.pendingDestroy.push(texture);
  }

  /**
   * Destroy all queued old GPU textures.
   * Must be called at the very beginning of each frame (before any render-pass recording)
   * so that no in-flight command buffer can still reference the resources being freed.
   */
  public static flushPendingDestroys(): void {
    for (const t of Texture.pendingDestroy) t.destroy();
    Texture.pendingDestroy.length = 0;
  }

  constructor(options: TextureOptions) {
    super({
      ...options,
      type: ResourceType.TEXTURE,
    });
    this.genMipmaps = options.genMipmaps ?? true;
    this.isNormalMap = options.isNormalMap ?? false;

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

  /**
   * Subscribe to texture view changes (fired after a streaming upgrade replaces the GPU view).
   * Returns an unsubscribe function.
   */
  public addViewListener(cb: () => void): () => void {
    this.viewListeners.add(cb);
    return () => this.viewListeners.delete(cb);
  }

  /**
   * Returns true while the texture is loaded at reduced resolution and has not yet been
   * upgraded to full resolution.
   */
  public isStreamable(): boolean {
    return this.streamingState !== null && !this.streamingState.isFullyLoaded;
  }

  /**
   * Asynchronously re-fetches the original image at full resolution, allocates a new GPU
   * texture with the complete mip chain, and swaps out the low-res placeholder.
   * Fires all registered view listeners on completion so Materials can rebuild bind groups.
   * Never blocks the calling frame — all heavy work is done in microtasks / GPU queue.
   */
  public async streamFullResolution(): Promise<void> {
    if (!this.streamingState || this.streamingState.isFullyLoaded || this.upgradePending) return;
    this.upgradePending = true;
    try {
      const { fullWidth, fullHeight } = this.streamingState;

      const response = await ResourceManager.fetch(`assets/textures/${this.path}`);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      const mipLevelCount = this.genMipmaps
        ? Math.floor(Math.log2(Math.max(fullWidth, fullHeight))) + 1
        : 1;

      const newGPUTexture = GPUUtils.createTextureWithMipmaps(
        `${this.label}_texture`,
        fullWidth,
        fullHeight,
        this.format,
        this.usage,
        mipLevelCount,
      );

      this.device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: newGPUTexture },
        { width: fullWidth, height: fullHeight },
      );

      imageBitmap.close();

      // Swap this.texture so generateMipmaps() operates on the new full-res texture.
      const oldGPUTexture = this.texture;
      this.texture = newGPUTexture;

      try {
        if (this.genMipmaps && mipLevelCount > 1) {
          await this.generateMipmaps();
        }
      } catch (err) {
        // Revert on mipmap generation failure.
        this.texture = oldGPUTexture;
        newGPUTexture.destroy();
        throw err;
      }

      // Install the new full-res view.
      this.textureView = newGPUTexture.createView({
        label: `${this.label}_textureView`,
        baseMipLevel: 0,
        mipLevelCount,
      });

      this.streamingState.isFullyLoaded = true;

      // Notify Materials to rebuild their bind groups. From this point, all new render
      // commands will use the new texture view.
      this.viewListeners.forEach((cb) => cb());

      // Defer the destruction of the old placeholder until the start of the next frame.
      // TextureStreamingManager.update() calls Texture.flushPendingDestroys() before any
      // command-buffer recording, guaranteeing that every device.queue.submit() that could
      // reference the old texture (via old bind groups recorded in previous frames) has
      // already happened before the resource is freed. This is more reliable than
      // onSubmittedWorkDone(), which only captures work queued at the exact call-site and
      // can resolve before the current frame's submit() if execution interleaves at the
      // wrong microtask boundary.
      if (oldGPUTexture) Texture.deferDestroy(oldGPUTexture);
    } finally {
      this.upgradePending = false;
    }
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

  /**
   * Creates a GPU texture directly from raw RGBA8 pixel data (Uint8Array).
   * If a texture with `label` is already registered in the ResourceManager, its
   * GPU data is updated in-place (no allocation overhead on rebuild).
   * The texture is registered under `label` so Material.loadTexture() can find it.
   *
   * @param label      Unique identifier used as the resource path.
   * @param width      Texture width in pixels.
   * @param height     Texture height in pixels.
   * @param data       RGBA8 pixel data, row-major, length must equal width * height * 4.
   */
  public static createFromPixelData(
    label: string,
    width: number,
    height: number,
    data: Uint8Array,
  ): Texture {
    // Reuse existing instance so the ResourceManager path stays stable.
    try {
      const existing = ResourceManager.getResource<Texture>(label);
      existing.uploadPixelData(width, height, data);
      return existing;
    } catch {
      // Not registered yet — create fresh.
    }

    const tex = new Texture({
      path: label,
      type: ResourceType.TEXTURE,
      genMipmaps: false,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    ResourceManager.registerResource(tex);
    tex.uploadPixelData(width, height, data);
    return tex;
  }

  /** Uploads raw RGBA8 pixels to the GPU texture, replacing any previous content. */
  private uploadPixelData(width: number, height: number, data: Uint8Array): void {
    // Destroy previous GPU texture to free VRAM before allocating a new one.
    this.texture?.destroy();

    this.texture = this.device.createTexture({
      label: `${this.label}_texture`,
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      mipLevelCount: 1,
    });

    this.device.queue.writeTexture(
      { texture: this.texture },
      data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );

    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    this.sampler = SamplerLibrary.anisotropic16x;
    this.setHasData();
  }

  public static async getAsync(path: string, isNormalMap = false): Promise<Texture> {
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
    const texture = new Texture({ path, type: ResourceType.TEXTURE, isNormalMap });
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
    // ── Try KTX2 compressed format first ─────────────────────────────────────
    // ktx2PathFor() swaps the extension, e.g. "diffuse.png" / "diffuse.webp" → "diffuse.ktx2".
    // ResourceManager.fetch throws on 404, so we catch silently and fall through
    // to the PNG/WebP path when the .ktx2 file does not exist yet.
    const useKTX2 = QualitySettings.getInstance().getSettings().useKTX2;
    if (useKTX2) {
      const ktx2Path = KTX2Loader.ktx2PathFor(this.path);
      try {
        const resp = await ResourceManager.fetch(`assets/textures/${ktx2Path}`);
        const buffer = await resp.arrayBuffer();
        const ktx2 = await KTX2Loader.decode(buffer);
        this.uploadKTX2(ktx2);
        return;
      } catch (e) {
        // .ktx2 not present or transcode error — fall through to PNG / WebP.
        // Log only once per path to avoid console spam on legitimate 404s.
        if (
          e instanceof Error &&
          !e.message.includes('404') &&
          !(e as Error & { logged?: boolean }).logged
        ) {
          (e as Error & { logged?: boolean }).logged = true;
          console.warn(`[Texture/KTX2] fallback for ${this.path}:`, e.message);
        }
      }
    }

    // ── PNG / WebP fallback ───────────────────────────────────────────────────
    const response = await ResourceManager.fetch(`assets/textures/${this.path}`);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);
    const fullWidth = imageBitmap.width;
    const fullHeight = imageBitmap.height;

    // ── Streaming: placeholder upload at reduced resolution ──────────────────
    // Textures ≥ 128 px that are not engine placeholders are streamed:
    // an initial 64×64 thumbnail is uploaded immediately (cheap VRAM), then
    // TextureStreamingManager replaces it with the full-res version when the
    // owning entity comes within range.
    const STREAM_SKIP = new Set(['white.png', 'black.png', 'no-normal.jpg']);
    const useStreaming = !STREAM_SKIP.has(this.path) && Math.max(fullWidth, fullHeight) >= 128;

    if (useStreaming) {
      const INITIAL_MAX_DIM = 64;
      const scale = INITIAL_MAX_DIM / Math.max(fullWidth, fullHeight);
      const initW = Math.max(1, Math.round(fullWidth * scale));
      const initH = Math.max(1, Math.round(fullHeight * scale));

      // Downscale via OffscreenCanvas (works with any ImageBitmap).
      const offscreen = new OffscreenCanvas(initW, initH);
      const ctx = offscreen.getContext('2d')!;
      ctx.drawImage(imageBitmap, 0, 0, initW, initH);
      const smallBitmap = await createImageBitmap(offscreen);
      imageBitmap.close();

      const initMipCount = this.genMipmaps
        ? Math.floor(Math.log2(Math.max(initW, initH))) + 1
        : 1;

      this.texture = GPUUtils.createTextureWithMipmaps(
        `${this.label}_texture`,
        initW,
        initH,
        this.format,
        this.usage,
        initMipCount,
      );

      this.device.queue.copyExternalImageToTexture(
        { source: smallBitmap },
        { texture: this.texture },
        { width: initW, height: initH },
      );

      if (this.genMipmaps && initMipCount > 1) {
        await this.generateMipmaps();
      }

      smallBitmap.close();

      this.textureView = this.texture.createView({
        label: `${this.label}_textureView`,
        baseMipLevel: 0,
        mipLevelCount: initMipCount,
      });

      const useNearest =
        QualitySettings.getInstance().getSettings().meshTextureFilter === 'nearest';
      this.sampler = useNearest ? SamplerLibrary.nearestRepeat : SamplerLibrary.anisotropic16x;

      // Record the full dimensions so streamFullResolution() knows the target size.
      this.streamingState = { isFullyLoaded: false, fullWidth, fullHeight };
      this.setHasData();
      return;
    }

    // ── Standard (non-streaming) path ────────────────────────────────────────
    const mipLevelCount = this.genMipmaps
      ? Math.floor(Math.log2(Math.max(fullWidth, fullHeight))) + 1
      : 1;

    // Create GPU texture
    this.texture = GPUUtils.createTextureWithMipmaps(
      `${this.label}_texture`,
      fullWidth,
      fullHeight,
      this.format,
      this.usage,
      mipLevelCount,
    );

    // Copy image data
    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.texture },
      { width: fullWidth, height: fullHeight },
    );

    // Generate mipmaps if needed
    if (this.genMipmaps) {
      await this.generateMipmaps();
    }

    imageBitmap.close();

    // Create view and sampler
    this.textureView = this.texture.createView({
      label: `${this.label}_textureView`,
      baseMipLevel: 0,
      mipLevelCount,
    });

    const useNearest = QualitySettings.getInstance().getSettings().meshTextureFilter === 'nearest';
    this.sampler = useNearest ? SamplerLibrary.nearestRepeat : SamplerLibrary.anisotropic16x;

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
      const copyWidth = isCompressed ? blocksX * blockDim : mip.width;
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

    const useNearest = QualitySettings.getInstance().getSettings().meshTextureFilter === 'nearest';
    this.sampler = useNearest ? SamplerLibrary.nearestRepeat : SamplerLibrary.anisotropic16x;
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

    if (this.isNormalMap) {
      await Texture.mipmapGenerator.generateMipmapsFor2DNormal(this.texture, mipLevelCount);
    } else {
      await Texture.mipmapGenerator.generateMipmapsFor2D(this.texture, mipLevelCount);
    }
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
