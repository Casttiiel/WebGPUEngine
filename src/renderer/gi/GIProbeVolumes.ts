import { vec3 } from 'gl-matrix';
import { GPUUtils } from '../core/utils/GPUUtils';

/** Must match GI_IRR_RES / GI_VIS_RES in gi/common/gi_common.wgsl. */
export const GI_IRR_RES = 6;
export const GI_VIS_RES = 14;
const IRR_TILE = GI_IRR_RES + 2;
const VIS_TILE = GI_VIS_RES + 2;
export const GI_MAX_RAYS = 64;
export const GI_MAX_VOLUMES = 64;
/** GIVolume in gi/common/gi_common.wgsl: origin ivec4, dims uvec4, spacing vec4. */
const VOLUME_WORDS = 12;
/**
 * Local volumes farther than this from the camera are traced at FAR_LOCAL_SCALE of their
 * weight: still warm when the camera arrives (no pop from cascade to local lighting), cheap.
 */
const LOCAL_UPDATE_DISTANCE = 48;
const FAR_LOCAL_SCALE = 0.125;
/** Trace-weight multiplier of the local volume the camera is in (or within 2 m of). */
const INSIDE_BOOST = 4;

export type GIVolumeKind = 'local' | 'level' | 'cascade';
const KIND_CODE: Record<GIVolumeKind, number> = { local: 0, level: 1, cascade: 2 };

export interface GIVolumeDesc {
  kind: GIVolumeKind;
  dims: [number, number, number];
  spacing: number;
  /** Fixed min probe coordinate (local / level). Cascades re-centre on the camera. */
  origin?: [number, number, number];
  /** Share of the per-frame trace budget (relative). */
  weight: number;
  /** Edge fade width in probe cells. */
  fade: number;
}

export interface GIVolumeConfig {
  /** Sampled in this order: finest (local) first. */
  volumes: GIVolumeDesc[];
  raysPerProbe: number;
  /** Probes traced per frame; bigger volumes are refreshed over several frames. */
  batchSize: number;
}

export interface GIUpdate {
  volume: number;
  /** First slot (probe index within the volume) traced this frame. */
  first: number;
  count: number;
  /** Frames until the same probes are traced again (hysteresis scaling). */
  interval: number;
}

interface VolumeState {
  desc: GIVolumeDesc;
  probes: number;
  firstProbe: number;
  origin: [number, number, number];
  cursor: number;
  /** Stride-scheduling pass value: the volume with the lowest pass is traced next. */
  pass: number;
}

/**
 * GPU storage for the probe volumes (see gi/common/gi_common.wgsl): the volume list, irradiance
 * + visibility atlases (sampled copy + scratch the integration writes), per-probe state, and the
 * ray results of this frame's batch.
 *
 * Volumes:
 *  - local   — gi_volume components (interiors): fine grid, fixed; traced most when the camera
 *              is in or near it, rarely when far (kept warm for when the camera arrives)
 *  - level   — one grid fitted to an enclosed level: uniform resolution, no change with distance
 *  - cascade — camera-centred, spacing doubling (open worlds); re-centres at its first batch
 * One batch of one volume is traced per frame, picked by stride scheduling over the weights.
 */
export class GIProbeVolumes {
  public readonly config: GIVolumeConfig;
  public readonly totalProbes: number;
  /** Atlas tiles per row (tiles are row-major by global probe index). */
  public readonly tilesPerRow: number;

  private irradianceRead: GPUTexture;
  private irradianceScratch: GPUTexture;
  private visibilityRead: GPUTexture;
  private visibilityScratch: GPUTexture;
  public readonly irradianceReadView: GPUTextureView;
  public readonly irradianceScratchView: GPUTextureView;
  public readonly visibilityReadView: GPUTextureView;
  public readonly visibilityScratchView: GPUTextureView;
  public readonly stateBuffer: GPUBuffer;
  public readonly raysBuffer: GPUBuffer;
  public readonly volumesBuffer: GPUBuffer;

  private volumes: VolumeState[];
  private volumeData: ArrayBuffer;
  private volumesDirty = true;
  private initialised = false;

  constructor(config: GIVolumeConfig) {
    this.config = config;
    let offset = 0;
    this.volumes = config.volumes.slice(0, GI_MAX_VOLUMES).map((desc) => {
      const probes = desc.dims[0] * desc.dims[1] * desc.dims[2];
      const v: VolumeState = {
        desc,
        probes,
        firstProbe: offset,
        origin: desc.origin ? [...desc.origin] : [0, 0, 0],
        cursor: 0,
        pass: 0,
      };
      offset += probes;
      return v;
    });
    this.totalProbes = offset;
    this.tilesPerRow = Math.ceil(Math.sqrt(offset));
    const rows = Math.ceil(offset / this.tilesPerRow);
    const device = GPUUtils.getDevice();

    const atlas = (label: string, tile: number, usage: number) =>
      device.createTexture({
        label,
        size: { width: this.tilesPerRow * tile, height: rows * tile },
        format: 'rgba16float',
        usage,
      });
    const read = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const scratch = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    this.irradianceRead = atlas('gi_irradiance_atlas', IRR_TILE, read);
    this.irradianceScratch = atlas('gi_irradiance_scratch', IRR_TILE, scratch);
    this.visibilityRead = atlas('gi_visibility_atlas', VIS_TILE, read);
    this.visibilityScratch = atlas('gi_visibility_scratch', VIS_TILE, scratch);
    this.irradianceReadView = this.irradianceRead.createView();
    this.irradianceScratchView = this.irradianceScratch.createView();
    this.visibilityReadView = this.visibilityRead.createView();
    this.visibilityScratchView = this.visibilityScratch.createView();

    // Every slot starts holding an impossible coordinate → treated as missing until traced.
    const state = new Float32Array(offset * 8);
    for (let i = 0; i < offset; i++) state.fill(1e9, i * 8 + 4, i * 8 + 7);
    this.stateBuffer = GPUUtils.createBuffer(
      'gi_probe_state',
      state.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      state,
    );
    const maxBatch = Math.max(...this.volumes.map((v) => Math.min(config.batchSize, v.probes)));
    this.raysBuffer = GPUUtils.createBuffer(
      'gi_probe_rays',
      maxBatch * config.raysPerProbe * 16,
      GPUBufferUsage.STORAGE,
    );
    this.volumeData = new ArrayBuffer(GI_MAX_VOLUMES * VOLUME_WORDS * 4);
    this.volumesBuffer = GPUUtils.createBuffer(
      'gi_volumes',
      this.volumeData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
  }

  public get volumeCount(): number {
    return this.volumes.length;
  }

  public get irradianceAtlasSize(): [number, number] {
    return [this.irradianceRead.width, this.irradianceRead.height];
  }

  public get visibilityAtlasSize(): [number, number] {
    return [this.visibilityRead.width, this.visibilityRead.height];
  }

  /** Picks this frame's volume and batch (re-centring a cascade at its first batch). */
  public advance(camera: vec3): GIUpdate {
    if (!this.initialised) {
      this.volumes.forEach((v) => v.desc.kind === 'cascade' && this.recentre(v, camera));
      this.initialised = true;
    }

    let pick: VolumeState | null = null;
    let pickWeight = 1;
    let weightSum = 0;
    for (const v of this.volumes) {
      const d = this.distanceTo(v, camera);
      let weight = v.desc.weight;
      if (v.desc.kind === 'local') {
        if (d <= 2) weight *= INSIDE_BOOST;
        else if (d > LOCAL_UPDATE_DISTANCE) weight *= FAR_LOCAL_SCALE;
      }
      weightSum += weight;
      if (!pick || v.pass < pick.pass) {
        pick = v;
        pickWeight = weight;
      }
    }
    pick ??= this.volumes[0]!;
    weightSum = Math.max(weightSum, pickWeight);
    // Keep newly eligible volumes from catching up with a burst of updates.
    for (const v of this.volumes) if (v.pass < pick.pass) v.pass = pick.pass;
    pick.pass += 1 / pickWeight;

    const first = pick.cursor;
    if (first === 0 && pick.desc.kind === 'cascade') this.recentre(pick, camera);
    const batch = Math.min(this.config.batchSize, pick.probes);
    const count = Math.min(batch, pick.probes - first);
    pick.cursor = first + count >= pick.probes ? 0 : first + count;

    if (this.volumesDirty) this.uploadVolumes();
    return {
      volume: this.volumes.indexOf(pick),
      first,
      count,
      interval: (weightSum / pickWeight) * Math.ceil(pick.probes / batch),
    };
  }

  /** Distance from the camera to a volume's box (0 inside). */
  private distanceTo(v: VolumeState, camera: vec3): number {
    if (v.desc.kind === 'cascade') return 0;
    const s = v.desc.spacing;
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const lo = v.origin[k]! * s;
      const hi = (v.origin[k]! + v.desc.dims[k]! - 1) * s;
      const d = Math.max(lo - camera[k]!, 0, camera[k]! - hi);
      d2 += d * d;
    }
    return Math.sqrt(d2);
  }

  private recentre(v: VolumeState, camera: vec3): void {
    for (let k = 0; k < 3; k++) {
      const o = Math.floor(camera[k]! / v.desc.spacing) - (v.desc.dims[k]! >> 1);
      if (o !== v.origin[k]) {
        v.origin[k] = o;
        this.volumesDirty = true;
      }
    }
  }

  private uploadVolumes(): void {
    const i32 = new Int32Array(this.volumeData);
    const u32 = new Uint32Array(this.volumeData);
    const f32 = new Float32Array(this.volumeData);
    this.volumes.forEach((v, i) => {
      const o = i * VOLUME_WORDS;
      i32.set(v.origin, o);
      u32.set([v.desc.dims[0], v.desc.dims[1], v.desc.dims[2], v.firstProbe], o + 4);
      f32.set([v.desc.spacing, v.desc.fade, KIND_CODE[v.desc.kind], 0], o + 8);
    });
    GPUUtils.writeBuffer(this.volumesBuffer, 0, this.volumeData);
    this.volumesDirty = false;
  }

  /** Copies the atlas rows holding the batch the integration just wrote, scratch → sampled. */
  public copyBatch(encoder: GPUCommandEncoder, update: GIUpdate): void {
    const firstIndex = this.volumes[update.volume]!.firstProbe + update.first;
    const firstRow = Math.floor(firstIndex / this.tilesPerRow);
    const lastRow = Math.floor((firstIndex + update.count - 1) / this.tilesPerRow);
    const copy = (src: GPUTexture, dst: GPUTexture, tile: number) =>
      encoder.copyTextureToTexture(
        { texture: src, origin: { x: 0, y: firstRow * tile } },
        { texture: dst, origin: { x: 0, y: firstRow * tile } },
        { width: src.width, height: (lastRow - firstRow + 1) * tile },
      );
    copy(this.irradianceScratch, this.irradianceRead, IRR_TILE);
    copy(this.visibilityScratch, this.visibilityRead, VIS_TILE);
  }

  /** Volume summaries for debugging (eval / menu). */
  public describe(): { kind: GIVolumeKind; dims: number[]; spacing: number; origin: number[] }[] {
    return this.volumes.map((v) => ({
      kind: v.desc.kind,
      dims: [...v.desc.dims],
      spacing: v.desc.spacing,
      origin: [...v.origin],
    }));
  }

  public destroy(): void {
    this.irradianceRead.destroy();
    this.irradianceScratch.destroy();
    this.visibilityRead.destroy();
    this.visibilityScratch.destroy();
    this.stateBuffer.destroy();
    this.raysBuffer.destroy();
    this.volumesBuffer.destroy();
  }
}
