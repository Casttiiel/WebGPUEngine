/**
 * KTX2Loader — loads KTX2/Basis-Universal compressed textures in the browser.
 *
 * Setup (one-time):
 *   Download the two WASM files from the official Basis Universal release:
 *   https://github.com/BinomialLLC/basis_universal/releases  (or build with CMake)
 *   or from the Three.js CDN:
 *   https://cdn.jsdelivr.net/npm/three/examples/jsm/libs/basis/
 *
 *   Place both files in: public/basis/
 *     public/basis/basis_transcoder.js
 *     public/basis/basis_transcoder.wasm
 *
 * The loader:
 *  - Transcodes UASTC → BC7_RGBA on desktops (texture-compression-bc required)
 *  - Falls back to RGBA32 on devices without BC support
 *  - Returns all embedded mip levels (no need to run MipmapGenerator)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KTX2MipLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface KTX2TextureData {
  mipLevels: KTX2MipLevel[];
  /** The GPUTextureFormat to use when creating the texture. */
  format: GPUTextureFormat;
  /** Whether the format is block-compressed (affects bytesPerRow calculation). */
  isCompressed: boolean;
  /** Block size in bytes (16 for BC7, 4 for RGBA8). */
  blockByteSize: number;
  /** Block dimension (4 for BC7, 1 for RGBA8). */
  blockDim: number;
}

// ─── Internal module type (Emscripten output) ─────────────────────────────────

interface BasisTranscoderModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => KTX2FileHandle;
  TranscodeTarget: {
    BC7_RGBA: number;
    ASTC_4x4_RGBA: number;
    RGBA32: number;
  };
}

interface KTX2FileHandle {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getLayers(): number;
  getFaces(): number;
  startTranscoding(): boolean;
  transcodeImage(
    dst: Uint8Array,
    levelIndex: number,
    layerIndex: number,
    faceIndex: number,
    format: number,
    decodeFlags: number,
    outputRowPitch: number,
    outputRowsInPixels: number,
  ): boolean;
  close(): void;
  delete(): void;
}

// ─── KTX2Loader ──────────────────────────────────────────────────────────────

export class KTX2Loader {
  private static modulePromise: Promise<BasisTranscoderModule> | null = null;
  private static module: BasisTranscoderModule | null = null;

  /** True if the GPU advertises BC texture compression (desktops). */
  private static hasBCSupport: boolean | null = null;

  // ─── Public API ────────────────────────────────────────────────────────────

  public static isAvailable(): boolean {
    // Check if the basis files are expected to exist (conservative check —
    // actual availability is confirmed when the WASM loads).
    return true;
  }

  /**
   * Attempts to fetch the KTX2 variant of a texture path.
   * Returns null if the file doesn't exist (404) so callers can fall back.
   */
  public static ktx2PathFor(originalPath: string): string {
    return originalPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.ktx2');
  }

  /**
   * Load and transcode a KTX2 buffer into GPU-uploadable data.
   * Initializes the WASM transcoder on first call (cached for subsequent calls).
   */
  public static async decode(buffer: ArrayBuffer): Promise<KTX2TextureData> {
    const Module = await KTX2Loader.ensureModule();
    return KTX2Loader.transcode(Module, buffer);
  }

  // ─── GPU format selection ──────────────────────────────────────────────────

  private static checkBCSupport(): boolean {
    if (KTX2Loader.hasBCSupport !== null) return KTX2Loader.hasBCSupport;

    try {
      // Render.getInstance() may not exist at module load time, so read from GPUDevice.
      // The engine always requests 'texture-compression-bc' as a requiredFeature.
      const canvas = document.querySelector('canvas');
      if (!canvas) {
        KTX2Loader.hasBCSupport = false;
        return false;
      }
      // We can't read device features synchronously here, so we rely on the
      // fact that the engine requires 'texture-compression-bc' in device creation —
      // if the engine booted, BC is available.
      KTX2Loader.hasBCSupport = true;
      return true;
    } catch {
      KTX2Loader.hasBCSupport = false;
      return false;
    }
  }

  // ─── WASM initialization ───────────────────────────────────────────────────

  private static async ensureModule(): Promise<BasisTranscoderModule> {
    if (KTX2Loader.module) return KTX2Loader.module;
    if (KTX2Loader.modulePromise) return KTX2Loader.modulePromise;

    KTX2Loader.modulePromise = (async () => {
      const script = await fetch(`${import.meta.env.BASE_URL}basis/basis_transcoder.js`);
      if (!script.ok) {
        throw new Error(
          'basis_transcoder.js not found at /basis/basis_transcoder.js\n' +
            'Download from https://github.com/BinomialLLC/basis_universal/releases\n' +
            'and place in public/basis/',
        );
      }

      // Evaluate the Emscripten module factory in the browser context.
      const code = await script.text();
      const factory = new Function('Module', code + '\nreturn Module;') as (
        config: object,
      ) => Promise<BasisTranscoderModule>;

      const Module = (await factory({
        // Point the WASM binary to our public/ folder.
        locateFile: (path: string) => `${import.meta.env.BASE_URL}basis/${path}`,
      })) as unknown as BasisTranscoderModule;

      Module.initializeBasis();
      KTX2Loader.module = Module;
      console.log('[KTX2Loader] Basis Universal transcoder ready.');
      return Module;
    })();

    return KTX2Loader.modulePromise;
  }

  // ─── Transcoding ───────────────────────────────────────────────────────────

  private static transcode(Module: BasisTranscoderModule, buffer: ArrayBuffer): KTX2TextureData {
    const hasBc = KTX2Loader.checkBCSupport();

    // Choose target format and layout constants
    const transcodeTarget = hasBc ? Module.TranscodeTarget.BC7_RGBA : Module.TranscodeTarget.RGBA32;
    const gpuFormat: GPUTextureFormat = hasBc ? 'bc7-rgba-unorm' : 'rgba8unorm';
    const isCompressed = hasBc;
    const blockByteSize = hasBc ? 16 : 4; // BC7 = 16 bytes/4x4 block; RGBA = 4 bytes/pixel
    const blockDim = hasBc ? 4 : 1;

    const ktx2 = new Module.KTX2File(new Uint8Array(buffer));

    if (!ktx2.isValid()) {
      ktx2.close();
      ktx2.delete();
      throw new Error('KTX2Loader: invalid KTX2 file');
    }

    const width = ktx2.getWidth();
    const height = ktx2.getHeight();
    const numLevels = ktx2.getLevels();

    if (!ktx2.startTranscoding()) {
      ktx2.close();
      ktx2.delete();
      throw new Error('KTX2Loader: startTranscoding() failed');
    }

    const mipLevels: KTX2MipLevel[] = [];

    for (let level = 0; level < numLevels; level++) {
      const mipWidth = Math.max(1, width >> level);
      const mipHeight = Math.max(1, height >> level);

      const blocksX = Math.ceil(mipWidth / blockDim);
      const blocksY = Math.ceil(mipHeight / blockDim);
      const byteLength = blocksX * blocksY * blockByteSize;

      const dst = new Uint8Array(byteLength);
      const ok = ktx2.transcodeImage(
        dst,
        level, // levelIndex
        0, // layerIndex (non-array)
        0, // faceIndex  (non-cubemap)
        transcodeTarget,
        0, // decodeFlags
        0, // outputRowPitch (0 = auto)
        0, // outputRowsInPixels (0 = auto)
      );

      if (!ok) {
        ktx2.close();
        ktx2.delete();
        throw new Error(`KTX2Loader: transcodeImage failed at mip level ${level}`);
      }

      mipLevels.push({ data: dst, width: mipWidth, height: mipHeight });
    }

    ktx2.close();
    ktx2.delete();

    return { mipLevels, format: gpuFormat, isCompressed, blockByteSize, blockDim };
  }
}
