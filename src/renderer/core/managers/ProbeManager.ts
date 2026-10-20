import { mat4, vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { GPUUtils } from '../utils/GPUUtils';
import { SamplerLibrary } from '../utils/SamplerLibrary';
import type { ReflectionProbeComponent } from '../../../components/render/ReflectionProbeComponent';

/** Captured cube faces: 6 × size² RGBA half floats, WebGPU face order and orientation. */
export interface ProbeFaces {
  size: number;
  data: Uint16Array; // 6 · size · size · 4
}

/** Probes uploaded per frame (the closest to the camera). Must stay 32: one bit per probe in the grid masks. */
const MAX_ACTIVE = 32;
/** XZ grid over the active probes' boxes: per cell, a bitmask of the probes touching it. */
const GRID_DIM = 32;
const GRID_OFFSET = 4 + 9 * 4; // after count, hasGlobalSH, envMaxMip, ambientScale + globalSH[9]
const GRID_HEADER_FLOATS = 4; // gridMin.xy, gridInvCell.xy
// + cellMask[GRID_DIM²]
const HEADER_FLOATS = GRID_OFFSET + GRID_HEADER_FLOATS + GRID_DIM * GRID_DIM;
const PROBE_FLOATS = 13 * 4; // pos, boxMin, boxMax, fade + sh[9]
const GGX_SAMPLES = 96;

/**
 * ProbeManager — owns the GPU side of every ReflectionProbeComponent:
 *   • a cube array with each probe's GGX-prefiltered radiance (one cube per probe)
 *   • a storage buffer (ProbeSet, common/probes.wgsl) with the probes near the camera:
 *     box, fade, cube index and SH irradiance
 * The lighting shaders pick and blend probes per pixel from those, so any number of probes
 * work at once, whoever the "player" is (tactical camera, FPS, probe capture…).
 */
export class ProbeManager {
  private static _instance: ProbeManager | null = null;
  private _probes: ReflectionProbeComponent[] = [];
  /** During a bake only the sky lights the scene (bounce 1) unless a pass enables probes. */
  private _bakingMode = false;

  private device: GPUDevice | null = null;
  private probeSetBuffer: GPUBuffer | null = null;
  private probeSetData = new Float32Array(HEADER_FLOATS + MAX_ACTIVE * PROBE_FLOATS);
  private probeSetU32 = new Uint32Array(this.probeSetData.buffer);

  private envSize = 0;
  private envMips = 1;
  private envCapacity = 0; // cubes
  private envArray: GPUTexture | null = null;
  private envArrayView: GPUTextureView | null = null;
  private cubeIndex = new Map<ReflectionProbeComponent, number>();
  /** Captured faces per probe, to prefilter again if the cube resolution changes. */
  private faces = new Map<ReflectionProbeComponent, ProbeFaces>();
  private freeCubes: number[] = [];

  private prefilterPipeline: GPUComputePipeline | null = null;
  private downsamplePipeline: GPUComputePipeline | null = null;
  private pipelinePromise: Promise<void> | null = null;

  private readonly candidates: ReflectionProbeComponent[] = [];
  private readonly distances = new Map<ReflectionProbeComponent, number>();
  private readonly frustumPlanes = new Float32Array(24);
  private readonly byDistance = (a: ReflectionProbeComponent, b: ReflectionProbeComponent) =>
    this.distances.get(a)! - this.distances.get(b)!;

  private constructor() {}

  public static getInstance(): ProbeManager {
    if (!ProbeManager._instance) ProbeManager._instance = new ProbeManager();
    return ProbeManager._instance;
  }

  public register(probe: ReflectionProbeComponent): void {
    if (!this._probes.includes(probe)) this._probes.push(probe);
  }

  public unregister(probe: ReflectionProbeComponent): void {
    const idx = this._probes.indexOf(probe);
    if (idx !== -1) this._probes.splice(idx, 1);
    this.distances.delete(probe);
    this.faces.delete(probe);
    const cube = this.cubeIndex.get(probe);
    if (cube !== undefined) {
      this.cubeIndex.delete(probe);
      this.freeCubes.push(cube);
    }
  }

  public getProbes(): ReadonlyArray<ReflectionProbeComponent> {
    return this._probes;
  }

  /** While baking, probes are hidden from the lighting (the sky alone lights bounce 1). */
  public setBakingMode(enabled: boolean): void {
    this._bakingMode = enabled;
  }

  // ── GPU resources ────────────────────────────────────────────────────────────

  private ensureResources(): void {
    if (this.probeSetBuffer) return;
    this.device = GPUUtils.getDevice();
    this.probeSetBuffer = this.device.createBuffer({
      label: 'probe_set',
      size: this.probeSetData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 1×1 placeholder so the bind groups are valid before any probe has a cubemap.
    this.allocateEnvArray(1, 1);
  }

  /** ProbeSet storage buffer (read by ambient.fs, ambient_specular.fs and ssr.cs). */
  public getProbeSetBuffer(): GPUBuffer {
    this.ensureResources();
    return this.probeSetBuffer!;
  }

  /** Cube-array view of every probe's prefiltered radiance. Changes when it grows. */
  public getEnvArrayView(): GPUTextureView {
    this.ensureResources();
    return this.envArrayView!;
  }

  private allocateEnvArray(size: number, capacity: number): void {
    const device = this.device!;
    const mips = Math.floor(Math.log2(size)) + 1;
    const texture = device.createTexture({
      label: 'probe_env_array',
      size: [size, size, 6 * capacity],
      format: 'rgba16float',
      mipLevelCount: mips,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    });
    const keep = this.envArray !== null && this.envSize === size;
    if (keep) {
      // Growing: keep the cubes already prefiltered.
      const encoder = device.createCommandEncoder({ label: 'probe_env_array_grow' });
      for (let mip = 0; mip < mips; mip++) {
        const s = Math.max(1, size >> mip);
        encoder.copyTextureToTexture(
          { texture: this.envArray!, mipLevel: mip },
          { texture, mipLevel: mip },
          [s, s, 6 * this.envCapacity],
        );
      }
      device.queue.submit([encoder.finish()]);
    } else {
      // New resolution: every cube has to be prefiltered again (setProbeEnv does it).
      this.cubeIndex.clear();
      this.freeCubes = [];
      this.envCapacity = 0;
    }
    this.envArray?.destroy();
    this.envArray = texture;
    this.envSize = size;
    this.envMips = mips;
    for (let c = this.envCapacity; c < capacity; c++) this.freeCubes.push(c);
    this.freeCubes.sort((x, y) => y - x); // pop() hands out the lowest index
    this.envCapacity = capacity;
    this.envArrayView = texture.createView({
      label: 'probe_env_array_view',
      dimension: 'cube-array',
      arrayLayerCount: 6 * capacity,
    });
  }

  /**
   * Resolution of the probe cubes: 128 when the scene has few probes, 64 for big grids
   * (memory: 6 · size² · 8 bytes · 1.33 per probe). Sharp reflections come from SSR.
   */
  private desiredEnvSize(): number {
    return this._probes.length <= 48 ? 128 : 64;
  }

  private cubeFor(probe: ReflectionProbeComponent): number {
    const existing = this.cubeIndex.get(probe);
    if (existing !== undefined) return existing;
    const size = this.desiredEnvSize();
    if (this.envSize !== size) {
      this.allocateEnvArray(size, Math.max(1, this._probes.length));
      for (const [other, faces] of this.faces) {
        if (other !== probe) void this.setProbeEnv(other, faces);
      }
    } else if (this.freeCubes.length === 0) {
      this.allocateEnvArray(size, Math.max(this.envCapacity * 2, this._probes.length));
    }
    const cube = this.freeCubes.pop()!;
    this.cubeIndex.set(probe, cube);
    return cube;
  }

  private async ensurePipelines(): Promise<void> {
    if (this.prefilterPipeline) return;
    this.pipelinePromise ??= (async () => {
      const device = this.device!;
      const code = await ResourceManager.loadShader('utility/probe_prefilter.cs');
      const module = device.createShaderModule({ label: 'probe_prefilter', code });
      [this.prefilterPipeline, this.downsamplePipeline] = await Promise.all([
        device.createComputePipelineAsync({
          label: 'probe_prefilter',
          layout: 'auto',
          compute: { module, entryPoint: 'prefilter' },
        }),
        device.createComputePipelineAsync({
          label: 'probe_downsample',
          layout: 'auto',
          compute: { module, entryPoint: 'downsample' },
        }),
      ]);
    })();
    await this.pipelinePromise;
  }

  /**
   * Uploads a probe's captured radiance and GGX-prefilters it into its cube of the array.
   * Any capture size works (the prefilter resamples by direction).
   */
  public async setProbeEnv(probe: ReflectionProbeComponent, faces: ProbeFaces): Promise<void> {
    this.ensureResources();
    await this.ensurePipelines();
    if (!this._probes.includes(probe)) return; // disposed while loading
    this.faces.set(probe, faces);
    const device = this.device!;
    const cube = this.cubeFor(probe);

    // Source cube with its own box mip chain (filtered importance sampling reads it).
    const srcMips = Math.floor(Math.log2(faces.size)) + 1;
    const src = device.createTexture({
      label: 'probe_capture',
      size: [faces.size, faces.size, 6],
      format: 'rgba16float',
      mipLevelCount: srcMips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: src },
      faces.data,
      { bytesPerRow: faces.size * 8, rowsPerImage: faces.size },
      [faces.size, faces.size, 6],
    );

    const encoder = device.createCommandEncoder({ label: 'probe_prefilter' });
    const params: GPUBuffer[] = [];
    {
      const pass = encoder.beginComputePass({ label: 'probe_downsample' });
      pass.setPipeline(this.downsamplePipeline!);
      for (let mip = 1; mip < srcMips; mip++) {
        const s = Math.max(1, faces.size >> mip);
        pass.setBindGroup(
          1,
          device.createBindGroup({
            layout: this.downsamplePipeline!.getBindGroupLayout(1),
            entries: [
              { binding: 0, resource: src.createView({ dimension: '2d-array', baseMipLevel: mip - 1, mipLevelCount: 1 }) },
              { binding: 1, resource: src.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 }) },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
      }
      pass.end();
    }
    {
      const pass = encoder.beginComputePass({ label: 'probe_ggx' });
      pass.setPipeline(this.prefilterPipeline!);
      const srcView = src.createView({ dimension: 'cube' });
      for (let mip = 0; mip < this.envMips; mip++) {
        const s = Math.max(1, this.envSize >> mip);
        const buf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const u = new ArrayBuffer(32);
        new Uint32Array(u, 0, 3).set([s, faces.size, GGX_SAMPLES]);
        new Float32Array(u, 16, 1)[0] = this.envMips > 1 ? mip / (this.envMips - 1) : 0;
        device.queue.writeBuffer(buf, 0, u);
        params.push(buf);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.prefilterPipeline!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: srcView },
              { binding: 1, resource: SamplerLibrary.environmentCubemap },
              {
                binding: 2,
                resource: this.envArray!.createView({
                  dimension: '2d-array',
                  baseMipLevel: mip,
                  mipLevelCount: 1,
                  baseArrayLayer: cube * 6,
                  arrayLayerCount: 6,
                }),
              },
              { binding: 3, resource: { buffer: buf } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
      }
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    src.destroy();
    for (const b of params) b.destroy();
  }

  /** Cube index of a probe's prefiltered radiance, or -1 while it has none. */
  public getCubeIndex(probe: ReflectionProbeComponent): number {
    return this.cubeIndex.get(probe) ?? -1;
  }

  // ── Per frame ────────────────────────────────────────────────────────────────

  /**
   * Uploads the probes closest to `viewPos` (MAX_ACTIVE) and the global sky SH. With
   * `viewProj`, probes whose box (+ fade) is off screen are skipped: the shaders loop every
   * uploaded probe per pixel, so each one costs in ambient, ambient specular and SSR.
   */
  public update(viewPos: vec3, viewProj?: mat4): void {
    this.ensureResources();
    const data = this.probeSetData;
    const u32 = this.probeSetU32;
    data.fill(0);

    const globalSH = Engine.getEnvironmentManager().getEnvironmentSH();
    u32[1] = globalSH ? 1 : 0;
    data[2] = this.envMips - 1;
    // Same ambient energy as ambient.fs for forward-shaded things (lit particles).
    const ambient = Engine.getEnvironmentManager().getAmbientLightData();
    data[3] = ambient.globalFactor * ambient.diffuseFactor;
    if (globalSH) this.writeSH(globalSH, 4);

    let count = 0;
    if (!this._bakingMode) {
      // Reused scratch (this runs every frame): baked probes by distance to the viewer.
      const candidates = this.candidates;
      candidates.length = 0;
      if (viewProj) this.extractFrustumPlanes(viewProj);
      for (const p of this._probes) {
        if (p.getSHCoefficients() === null) continue;
        if (viewProj && !this.isProbeInFrustum(p)) continue;
        candidates.push(p);
      }
      for (const p of candidates) this.distances.set(p, this.distanceToBox(p, viewPos));
      candidates.sort(this.byDistance);
      if (candidates.length > MAX_ACTIVE) candidates.length = MAX_ACTIVE;
      for (const p of candidates) {
        const base = HEADER_FLOATS + count * PROBE_FLOATS;
        const pos = p.getPosition();
        const c = p.getBoxCenter();
        const ext = p.getExtents();
        data.set([pos[0], pos[1], pos[2], p.getProbeTypeFlag()], base);
        const fade = p.getFade();
        data.set([c[0] - ext[0], c[1] - ext[1], c[2] - ext[2], 0], base + 4);
        data.set([c[0] + ext[0], c[1] + ext[1], c[2] + ext[2], this.getCubeIndex(p)], base + 8);
        data.set([fade[0], fade[1], fade[2], 0], base + 12);
        this.writeSH(p.getSHCoefficients()!, base + 16);
        count++;
      }
      this.buildGrid(candidates);
    }
    u32[0] = count;
    GPUUtils.writeBuffer(this.probeSetBuffer!, 0, data.subarray(0, HEADER_FLOATS + Math.max(count, 1) * PROBE_FLOATS));
  }

  private writeSH(coefs: Float32Array, base: number): void {
    for (let k = 0; k < 9; k++) {
      this.probeSetData[base + k * 4] = coefs[k * 3]!;
      this.probeSetData[base + k * 4 + 1] = coefs[k * 3 + 1]!;
      this.probeSetData[base + k * 4 + 2] = coefs[k * 3 + 2]!;
    }
  }

  /**
   * Fills the XZ grid (common/probes.wgsl probeMask): the bounds of every uploaded box grown
   * by its fade, split in GRID_DIM² cells, each holding the bits of the probes that overlap
   * it. A pixel then loops only the 1–4 probes around it instead of every active one.
   * Left zeroed (count 0) when nothing is uploaded: every mask is 0.
   */
  private buildGrid(probes: ReadonlyArray<ReflectionProbeComponent>): void {
    if (probes.length === 0) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of probes) {
      const c = p.getBoxCenter();
      const e = p.getExtents();
      const f = p.getFade();
      minX = Math.min(minX, c[0] - e[0] - f[0]);
      maxX = Math.max(maxX, c[0] + e[0] + f[0]);
      minZ = Math.min(minZ, c[2] - e[2] - f[2]);
      maxZ = Math.max(maxZ, c[2] + e[2] + f[2]);
    }
    const invX = GRID_DIM / Math.max(maxX - minX, 1e-3);
    const invZ = GRID_DIM / Math.max(maxZ - minZ, 1e-3);
    const data = this.probeSetData;
    data[GRID_OFFSET] = minX;
    data[GRID_OFFSET + 1] = minZ;
    data[GRID_OFFSET + 2] = invX;
    data[GRID_OFFSET + 3] = invZ;
    const masks = this.probeSetU32;
    const cells = GRID_OFFSET + GRID_HEADER_FLOATS;
    const last = GRID_DIM - 1;
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i]!;
      const c = p.getBoxCenter();
      const e = p.getExtents();
      const f = p.getFade();
      const x0 = Math.max(Math.floor((c[0] - e[0] - f[0] - minX) * invX), 0);
      const x1 = Math.min(Math.floor((c[0] + e[0] + f[0] - minX) * invX), last);
      const z0 = Math.max(Math.floor((c[2] - e[2] - f[2] - minZ) * invZ), 0);
      const z1 = Math.min(Math.floor((c[2] + e[2] + f[2] - minZ) * invZ), last);
      const bit = (1 << i) >>> 0;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) masks[cells + z * GRID_DIM + x] = (masks[cells + z * GRID_DIM + x]! | bit) >>> 0;
      }
    }
  }

  /** Frustum planes (Gribb–Hartmann, normalized) of a column-major view-projection. */
  private extractFrustumPlanes(m: mat4): void {
    const planes = this.frustumPlanes;
    for (let i = 0; i < 6; i++) {
      const row = i >> 1;
      const sign = i & 1 ? -1 : 1;
      const a = m[3]! + sign * m[row]!;
      const b = m[7]! + sign * m[4 + row]!;
      const c = m[11]! + sign * m[8 + row]!;
      const d = m[15]! + sign * m[12 + row]!;
      const inv = 1 / (Math.hypot(a, b, c) || 1);
      planes[i * 4] = a * inv;
      planes[i * 4 + 1] = b * inv;
      planes[i * 4 + 2] = c * inv;
      planes[i * 4 + 3] = d * inv;
    }
  }

  /** The box grown by the fade: pixels up to `fade` outside it still get some weight. */
  private isProbeInFrustum(probe: ReflectionProbeComponent): boolean {
    const c = probe.getBoxCenter();
    const e = probe.getExtents();
    const f = probe.getFade();
    const hx = e[0] + f[0];
    const hy = e[1] + f[1];
    const hz = e[2] + f[2];
    const planes = this.frustumPlanes;
    for (let i = 0; i < 24; i += 4) {
      const px = planes[i]!;
      const py = planes[i + 1]!;
      const pz = planes[i + 2]!;
      const r = Math.abs(px) * hx + Math.abs(py) * hy + Math.abs(pz) * hz;
      if (px * c[0] + py * c[1] + pz * c[2] + planes[i + 3]! < -r) return false;
    }
    return true;
  }

  private distanceToBox(probe: ReflectionProbeComponent, p: vec3): number {
    const c = probe.getBoxCenter();
    const e = probe.getExtents();
    const dx = Math.max(Math.abs(p[0] - c[0]) - e[0], 0);
    const dy = Math.max(Math.abs(p[1] - c[1]) - e[1], 0);
    const dz = Math.max(Math.abs(p[2] - c[2]) - e[2], 0);
    return dx * dx + dy * dy + dz * dz;
  }
}
