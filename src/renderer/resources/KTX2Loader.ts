/**
 * KTX2Loader — loads KTX2/Basis-Universal compressed textures in the browser.
 *
 * Setup (one-time):
 *   The transcoder runtime is already included at:
 *     public/basis/basis_transcoder.js
 *     public/basis/basis_transcoder.wasm
 *
 * Texture generation (offline, run once per project):
 *   npm run compress-textures          (skip already-compressed)
 *   npm run compress-textures:force    (re-compress all)
 *
 * All transcoding runs inside Web Workers (NUM_WORKERS), so the main thread
 * is never blocked and textures are decoded in parallel, cutting load times
 * significantly compared to single-threaded main-thread transcoding.
 *
 * The loader:
 *  - Transcodes UASTC → BC7   on desktops with texture-compression-bc
 *  - Transcodes UASTC → ASTC  on mobile  with texture-compression-astc
 *  - Falls back  → RGBA32     when no compressed format is available
 *  - Returns all embedded mip levels (no MipmapGenerator needed at runtime)
 */

import { GPUUtils } from '../core/utils/GPUUtils';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface KTX2MipLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface KTX2TextureData {
  mipLevels: KTX2MipLevel[];
  /** GPUTextureFormat to use when creating the texture. */
  format: GPUTextureFormat;
  /** Whether the format is block-compressed. */
  isCompressed: boolean;
  /** Block size in bytes (16 for BC7/ASTC, 4 for RGBA8). */
  blockByteSize: number;
  /** Block dimension (4 for BC7/ASTC, 1 for RGBA8). */
  blockDim: number;
}

// ─── Internal worker message types ────────────────────────────────────────────

interface WorkerInitMsg     { type: 'init';      wasmBinary: ArrayBuffer; }
interface WorkerTranscodeMsg { type: 'transcode'; id: number; buffer: ArrayBuffer; hasBc: boolean; hasAstc: boolean; }

interface WorkerReadyMsg    { type: 'ready'; }
interface WorkerResultMsg   { type: 'result'; id: number; mipLevels: KTX2MipLevel[]; format: GPUTextureFormat; isCompressed: boolean; blockByteSize: number; blockDim: number; }
interface WorkerErrorMsg    { type: 'error';  id: number; message: string; }
interface WorkerInitErrMsg  { type: 'init_error'; message: string; }

type WorkerOutMsg = WorkerReadyMsg | WorkerResultMsg | WorkerErrorMsg | WorkerInitErrMsg;

type PendingJob = {
  resolve: (data: KTX2TextureData) => void;
  reject:  (err: Error) => void;
};

// ─── KTX2Loader ──────────────────────────────────────────────────────────────

export class KTX2Loader {
  /** Number of parallel transcoding workers. 2 halves load time, 4 quarters it. */
  private static readonly NUM_WORKERS = 2;

  private static hasBCSupport:   boolean | null = null;
  private static hasASTCSupport: boolean | null = null;

  private static workers:       Worker[]              = [];
  private static pendingJobs  = new Map<number, PendingJob>();
  private static nextJobId    = 0;
  private static nextWorkerIdx = 0;
  private static initPromise: Promise<void> | null = null;

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Returns the .ktx2 path for a given texture path, swapping the extension. */
  public static ktx2PathFor(originalPath: string): string {
    return originalPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.ktx2');
  }

  /**
   * Decodes a KTX2 ArrayBuffer into GPU-uploadable mip data.
   * Runs entirely in a background Worker — never blocks the main thread.
   */
  public static async decode(buffer: ArrayBuffer): Promise<KTX2TextureData> {
    await KTX2Loader.ensureWorkers();

    return new Promise<KTX2TextureData>((resolve, reject) => {
      const id = KTX2Loader.nextJobId++;
      KTX2Loader.pendingJobs.set(id, { resolve, reject });

      // Simple round-robin across the worker pool.
      const worker = KTX2Loader.workers[KTX2Loader.nextWorkerIdx % KTX2Loader.NUM_WORKERS]!;
      KTX2Loader.nextWorkerIdx++;

      const msg: WorkerTranscodeMsg = {
        type:   'transcode',
        id,
        buffer,
        hasBc:   KTX2Loader.checkBCSupport(),
        hasAstc: KTX2Loader.checkASTCSupport(),
      };
      worker.postMessage(msg, [buffer]); // zero-copy transfer
    });
  }

  // ─── GPU feature detection ────────────────────────────────────────────────────

  private static checkBCSupport(): boolean {
    if (KTX2Loader.hasBCSupport !== null) return KTX2Loader.hasBCSupport;
    try {
      KTX2Loader.hasBCSupport =
        GPUUtils.getDevice()?.features.has('texture-compression-bc') ?? false;
    } catch { KTX2Loader.hasBCSupport = false; }
    return KTX2Loader.hasBCSupport;
  }

  private static checkASTCSupport(): boolean {
    if (KTX2Loader.hasASTCSupport !== null) return KTX2Loader.hasASTCSupport;
    try {
      KTX2Loader.hasASTCSupport =
        GPUUtils.getDevice()?.features.has('texture-compression-astc') ?? false;
    } catch { KTX2Loader.hasASTCSupport = false; }
    return KTX2Loader.hasASTCSupport;
  }

  // ─── Worker pool ──────────────────────────────────────────────────────────────

  private static async ensureWorkers(): Promise<void> {
    if (KTX2Loader.workers.length === KTX2Loader.NUM_WORKERS) return;
    if (KTX2Loader.initPromise) { await KTX2Loader.initPromise; return; }

    KTX2Loader.initPromise = (async () => {
      const t0 = performance.now();

      // Fetch transcoder JS source and WASM binary in parallel.
      const [jsResp, wasmResp] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}basis/basis_transcoder.js`),
        fetch(`${import.meta.env.BASE_URL}basis/basis_transcoder.wasm`),
      ]);
      if (!jsResp.ok || !wasmResp.ok) {
        throw new Error(
          '[KTX2Loader] Failed to fetch basis_transcoder.{js,wasm} from public/basis/.',
        );
      }
      const [jsSource, wasmBinary] = await Promise.all([
        jsResp.text(),
        wasmResp.arrayBuffer(),
      ]);

      // Single Blob URL shared by all workers (revoked once workers are alive).
      const blob    = new Blob([KTX2Loader.buildWorkerSource(jsSource)], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);

      const readyPromises: Promise<void>[] = [];

      for (let i = 0; i < KTX2Loader.NUM_WORKERS; i++) {
        const worker = new Worker(blobUrl);

        // Permanent handler — routes transcode results back to callers.
        worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
          const msg = e.data;
          if (msg.type === 'result') {
            const job = KTX2Loader.pendingJobs.get(msg.id);
            if (!job) return;
            KTX2Loader.pendingJobs.delete(msg.id);
            job.resolve({
              mipLevels:    msg.mipLevels,
              format:       msg.format,
              isCompressed: msg.isCompressed,
              blockByteSize: msg.blockByteSize,
              blockDim:     msg.blockDim,
            });
          } else if (msg.type === 'error') {
            const job = KTX2Loader.pendingJobs.get(msg.id);
            if (!job) return;
            KTX2Loader.pendingJobs.delete(msg.id);
            job.reject(new Error(msg.message));
          }
        };

        // Temporary listener — waits for WASM ready signal from this worker.
        readyPromises.push(new Promise<void>((resolve, reject) => {
          const onInit = (e: MessageEvent<WorkerOutMsg>) => {
            if (e.data.type === 'ready') {
              worker.removeEventListener('message', onInit as EventListener);
              resolve();
            } else if (e.data.type === 'init_error') {
              worker.removeEventListener('message', onInit as EventListener);
              reject(new Error((e.data as WorkerInitErrMsg).message));
            }
          };
          worker.addEventListener('message', onInit as EventListener);
        }));

        // Each worker needs its own copy of the WASM binary (ArrayBuffer can't be shared).
        const wasmCopy = wasmBinary.slice(0);
        worker.postMessage({ type: 'init', wasmBinary: wasmCopy } as WorkerInitMsg, [wasmCopy]);
        KTX2Loader.workers.push(worker);
      }

      await Promise.all(readyPromises);
      URL.revokeObjectURL(blobUrl);

      console.log(
        `[KTX2Loader] ${KTX2Loader.NUM_WORKERS} workers ready` +
        `  (init: ${(performance.now() - t0).toFixed(0)}ms)`,
      );
    })();

    await KTX2Loader.initPromise;
  }

  // ─── Worker source ────────────────────────────────────────────────────────────

  /**
   * Builds the complete JS source string for a KTX2 transcoding worker.
   * The basis_transcoder.js IIFE is prepended so BASIS becomes a global,
   * exactly mirroring how Three.js uses the same transcoder binary.
   */
  private static buildWorkerSource(basisJs: string): string {
    return `
// ── Basis Universal IIFE (sets global BASIS) ─────────────────────────────────
${basisJs}

// ── KTX2 transcoding worker ──────────────────────────────────────────────────
// Hardcoded TranscoderFormat integers — the WASM does NOT export an enum.
// Source: https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/KTX2Loader.js
var TF = { BC7_M5: 7, ASTC_4x4: 10, RGBA32: 13 };

var BasisModule = null;

self.onmessage = function(e) {
  var msg = e.data;

  if (msg.type === 'init') {
    new Promise(function(resolve) {
      BasisModule = { wasmBinary: msg.wasmBinary, onRuntimeInitialized: resolve };
      BASIS(BasisModule);
    }).then(function() {
      BasisModule.initializeBasis();
      self.postMessage({ type: 'ready' });
    }).catch(function(err) {
      self.postMessage({ type: 'init_error', message: String(err) });
    });

  } else if (msg.type === 'transcode') {
    try {
      var result = transcode(msg.buffer, msg.hasBc, msg.hasAstc);
      var transferables = result.mipLevels.map(function(m) { return m.data.buffer; });
      self.postMessage(
        { type: 'result', id: msg.id,
          mipLevels:    result.mipLevels,
          format:       result.format,
          isCompressed: result.isCompressed,
          blockByteSize: result.blockByteSize,
          blockDim:     result.blockDim },
        transferables
      );
    } catch(err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
  }
};

function transcode(buffer, hasBc, hasAstc) {
  var target       = hasBc ? TF.BC7_M5 : hasAstc ? TF.ASTC_4x4 : TF.RGBA32;
  var gpuFormat    = hasBc ? 'bc7-rgba-unorm' : hasAstc ? 'astc-4x4-unorm' : 'rgba8unorm';
  var isCompressed = hasBc || hasAstc;
  var blockBytes   = isCompressed ? 16 : 4;
  var blockDim     = isCompressed ? 4  : 1;

  var ktx2 = new BasisModule.KTX2File(new Uint8Array(buffer));
  if (!ktx2.isValid()) { ktx2.close(); ktx2.delete(); throw new Error('KTX2Loader: invalid KTX2 file'); }

  var width     = ktx2.getWidth();
  var height    = ktx2.getHeight();
  var numLevels = ktx2.getLevels();

  if (!ktx2.startTranscoding()) { ktx2.close(); ktx2.delete(); throw new Error('KTX2Loader: startTranscoding() failed'); }

  var mipLevels = [];
  for (var level = 0; level < numLevels; level++) {
    var mipW = Math.max(1, width  >> level);
    var mipH = Math.max(1, height >> level);
    // Use WASM-computed output size — handles edge cases (sub-block mips, NPOT) correctly.
    var byteLength = ktx2.getImageTranscodedSizeInBytes(level, 0, 0, target);
    var dst = new Uint8Array(byteLength);
    var ok = ktx2.transcodeImage(dst, level, 0, 0, target, 0, -1, -1);
    if (!ok) { ktx2.close(); ktx2.delete(); throw new Error('KTX2Loader: transcodeImage failed at mip level ' + level); }
    mipLevels.push({ data: dst, width: mipW, height: mipH });
  }

  ktx2.close();
  ktx2.delete();
  return { mipLevels: mipLevels, format: gpuFormat, isCompressed: isCompressed, blockByteSize: blockBytes, blockDim: blockDim };
}
`;
  }
}
