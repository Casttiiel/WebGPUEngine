import { mat4, quat, vec3 } from 'gl-matrix';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { ProbeManager } from '../core/managers/ProbeManager';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Mesh } from '../resources/Mesh';
import { Texture } from '../resources/Texture';
import {
  GIProbeVolumes,
  GIUpdate,
  GIVolumeConfig,
  GIVolumeDesc,
  GI_MAX_RAYS,
  GI_MAX_VOLUMES,
} from './GIProbeVolumes';
import { GIVolumeComponent } from '../../components/render/GIVolumeComponent';
import { GIScene } from './GIScene';

export type GIMode = 'off' | 'realtime' | 'compare';
export const GI_MODES: readonly GIMode[] = ['off', 'realtime', 'compare'];

/** frameInfo.z in gi_debug.cs. */
export const GI_DEBUG_VIEWS = {
  none: 0,
  irradiance: 1,
  bvhAlbedo: 2,
  bvhNormals: 3,
  volumes: 4,
  coverage: 5,
} as const;
export type GIDebugView = keyof typeof GI_DEBUG_VIEWS;

/** Per quality: camera cascades (N³ each), rays per probe, probes traced per frame. */
const QUALITY: Record<'high' | 'low', { cascadeProbes: number; cascades: number; raysPerProbe: number; batchSize: number }> = {
  high: { cascadeProbes: 16, cascades: 4, raysPerProbe: 64, batchSize: 4096 },
  low: { cascadeProbes: 12, cascades: 3, raysPerProbe: 32, batchSize: 2048 },
};
/** Largest level volume (probes); bigger scenes coarsen the spacing, then fall back to cascades. */
const MAX_LEVEL_PROBES = 16384;
/** Probes of margin around the scene bounds in a level volume. */
const LEVEL_MARGIN = 1;

const MAX_LIGHTS = 32;
const LIGHT_FLOATS = 12;
/** GIParams in gi/common/gi_common.wgsl (13 × 16 bytes). */
const PARAMS_BYTES = 208;
/** Cascade weights in the trace schedule (finest traced most often). */
const CASCADE_WEIGHTS = [4, 2, 1, 1];
/** Trace weight of a local volume near the camera. */
const LOCAL_WEIGHT = 2;
/** Largest local volume (probes); a bigger box gets a coarser spacing. */
const MAX_LOCAL_PROBES = 4096;
/** Frames between checks for added/removed static geometry. */
const SCENE_CHECK_INTERVAL = 120;

/**
 * Realtime diffuse GI (idTech 8-style, software ray tracing — docs/realtime-gi-plan.md).
 *
 * Replaces only the ambient diffuse term: DeferredRenderer calls update() + renderDiffuse()
 * instead of AmbientLight.renderDiffuse() while the mode is not 'off'. Per frame:
 *   1. probe trace     — rays from the probes of one cascade through the scene BVH (GIScene),
 *                        hits lit by sun / one light / last frame's probes (multi-bounce)
 *   2. integrate       — rays → octahedral irradiance + visibility atlases (hysteresis)
 *   3. probe state     — relocation out of geometry, inactive probes, slot coordinates
 *   4. ambient_gi.fs   — per pixel: probe cascades (baked probes fill the gaps)
 * Created only while GI is on; destroy() releases every GPU resource.
 */
export class RealtimeGI {
  /** Tunables (menu). Static so they survive turning GI off and on. */
  public static readonly settings = {
    quality: 'high' as 'high' | 'low',
    /**
     * 'auto': one volume fitted to the level when it fits MAX_LEVEL_PROBES (uniform resolution,
     * no change with camera distance), camera cascades otherwise (open worlds).
     */
    volumes: 'auto' as 'auto' | 'level' | 'cascades',
    spacing: 1.0,
    hysteresis: 0.95,
    skyIntensity: 1.0,
    giIntensity: 1.0,
    bounce: 1.0,
    multiBounce: true,
    normalBias: 0.1,
    viewBias: 0.3,
    rayLength: 1000,
    compareSplit: 0.5,
    /** Resolution of the GI resolve relative to the render (0.5 = a quarter of the pixels). */
    resolution: 0.5,
    /** Screen-space temporal filter: weight of last frame's resolve (0 = off). */
    temporal: 0.9,
    debugView: 'none' as GIDebugView,
  };

  private mode: GIMode = 'realtime';
  private loaded = false;
  private scene = new GIScene();
  private volumes: GIProbeVolumes | null = null;
  private volumeKey = '';
  private frame = 0;
  private batch: GIUpdate = { volume: 0, first: 0, count: 0, interval: 1 };

  // ── Pipelines / layouts ─────────────────────────────────────────────────────
  private frameLayout!: GPUBindGroupLayout;
  private traceLayout!: GPUBindGroupLayout;
  private integrateLayout!: GPUBindGroupLayout;
  private stateLayout!: GPUBindGroupLayout;
  private ambientLayout!: GPUBindGroupLayout;
  private debugOutLayout!: GPUBindGroupLayout;
  private blitLayout!: GPUBindGroupLayout;
  private specularLayout!: GPUBindGroupLayout;
  private tracePipeline!: GPUComputePipeline;
  private irradiancePipeline!: GPUComputePipeline;
  private visibilityPipeline!: GPUComputePipeline;
  private statePipeline!: GPUComputePipeline;
  private debugPipeline!: GPUComputePipeline;
  private ambientPipeline!: GPURenderPipeline;
  private blitPipeline!: GPURenderPipeline;
  private specularPipeline!: GPURenderPipeline;
  private resolvePipeline!: GPUComputePipeline;
  private fullscreenQuad!: Mesh;
  private brdfLUT!: Texture;

  // ── Buffers / bind groups ───────────────────────────────────────────────────
  private paramsBuffer!: GPUBuffer;
  private paramsData = new ArrayBuffer(PARAMS_BYTES);
  private paramsF = new Float32Array(this.paramsData);
  private paramsU = new Uint32Array(this.paramsData);
  private lightsBuffer!: GPUBuffer;
  private lightsData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  private lightCount = 0;
  private rayRotation = mat4.create();
  private rotationQuat = quat.create();

  private frameBindGroup: GPUBindGroup | null = null;
  private frameBindGroupKey: unknown[] = [];
  private traceBindGroup: GPUBindGroup | null = null;
  private integrateBindGroup: GPUBindGroup | null = null;
  private stateBindGroup: GPUBindGroup | null = null;
  private ambientBindGroups = new Map<GPUTextureView, GPUBindGroup>();
  private ambientKey: unknown[] = [];
  private debugTexture: GPUTexture | null = null;
  private debugOutBindGroup: GPUBindGroup | null = null;
  private blitBindGroup: GPUBindGroup | null = null;
  private specularBindGroup: GPUBindGroup | null = null;
  /** Reduced-resolution GI irradiance (rgb) + specular scale (a), see gi/gi_resolve.cs. */
  /**
   * Ping-pong pair: [i] = (irradiance + specular scale, distance to camera). Frame N writes
   * pair `resolveParity` and reads the other as history (temporal filter).
   */
  private resolveTargets: { color: GPUTexture; distance: GPUTexture; colorView: GPUTextureView }[] = [];
  private resolveBindGroups: GPUBindGroup[] = [];
  private resolveParity = 0;
  private resolveView: GPUTextureView | null = null;
  private resolveLayout!: GPUBindGroupLayout;
  private temporalBuffer!: GPUBuffer;
  private temporalData = new Float32Array(24);
  private prevViewProj = mat4.create();
  private prevCameraPos = vec3.create();
  private historyValid = false;
  private lightRefs: (PointLightComponent | SpotLightComponent)[] = [];
  private lightOrder: number[] = [];
  private lightDist: number[] = [];
  private byLightDistance = (a: number, b: number) => this.lightDist[a]! - this.lightDist[b]!;

  public setMode(mode: GIMode): void {
    this.mode = mode;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public getScene(): GIScene {
    return this.scene;
  }

  // ─── Load ─────────────────────────────────────────────────────────────────

  public async load(): Promise<void> {
    const device = GPUUtils.getDevice();
    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;

    this.frameLayout = BindGroupFactory.getLayout('gi_frame_layout', [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'uniform' } }, // camera
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } }, // ProbeSet
      { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } }, // lights
      { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } }, // probe state
      { binding: 5, visibility: C, texture: { sampleType: 'float' } },
      { binding: 6, visibility: C, texture: { sampleType: 'float' } },
      { binding: 7, visibility: C, sampler: { type: 'filtering' } },
      { binding: 8, visibility: C, buffer: { type: 'read-only-storage' } }, // volumes
    ]);
    this.traceLayout = BindGroupFactory.getLayout('gi_trace_layout', [
      { binding: 0, visibility: C, buffer: { type: 'storage' } },
    ]);
    this.integrateLayout = BindGroupFactory.getLayout('gi_integrate_layout', [
      { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ]);
    this.stateLayout = BindGroupFactory.getLayout('gi_state_layout', [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'storage' } },
      { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } }, // volumes
    ]);
    this.ambientLayout = BindGroupFactory.getLayout('gi_ambient_layout', [
      { binding: 0, visibility: F, texture: { sampleType: 'float' } },
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
      { binding: 2, visibility: F, buffer: { type: 'uniform' } },
      { binding: 3, visibility: F, texture: { sampleType: 'float' } },
      { binding: 4, visibility: F, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: F, texture: { sampleType: 'float' } }, // GI resolve
    ]);
    this.debugOutLayout = BindGroupFactory.getLayout('gi_debug_out_layout', [
      { binding: 0, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ]);
    this.blitLayout = BindGroupFactory.getLayout('gi_blit_layout', [
      { binding: 0, visibility: F, texture: { sampleType: 'float' } },
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
    ]);
    this.resolveLayout = BindGroupFactory.getLayout('gi_resolve_layout', [
      { binding: 0, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } },
      { binding: 2, visibility: C, texture: { sampleType: 'float' } },
      { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: C, buffer: { type: 'uniform' } },
    ]);
    this.specularLayout = BindGroupFactory.getLayout('gi_specular_layout', [
      { binding: 0, visibility: F, texture: { sampleType: 'float' } }, // GI resolve
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
    ]);

    const [traceCode, integrateCode, stateCode, debugCode, ambientCode, blitCode, vsCode, specCode, resolveCode] =
      await Promise.all([
        ResourceManager.loadShader('gi/gi_probe_trace.cs'),
        ResourceManager.loadShader('gi/gi_probe_integrate.cs'),
        ResourceManager.loadShader('gi/gi_probe_state.cs'),
        ResourceManager.loadShader('gi/gi_debug.cs'),
        ResourceManager.loadShader('lighting/ambient_gi.fs'),
        ResourceManager.loadShader('gi/gi_blit.fs'),
        ResourceManager.loadShader('utility/presentation.vs'),
        ResourceManager.loadShader('lighting/ambient_specular.fs', ['REALTIME_GI']),
        ResourceManager.loadShader('gi/gi_resolve.cs'),
      ]);

    const sceneLayout = GIScene.getLayout();
    const compute = (label: string, code: string, entryPoint: string, layouts: GPUBindGroupLayout[]) =>
      device.createComputePipelineAsync({
        label,
        layout: PipelineFactory.createPipelineLayout(`${label}_layout`, layouts),
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
      });
    const integrateModule = device.createShaderModule({ label: 'gi_integrate', code: integrateCode });
    const integrateLayout = PipelineFactory.createPipelineLayout('gi_integrate_pl', [
      this.frameLayout,
      sceneLayout,
      this.integrateLayout,
    ]);

    const hdrFormat = QualitySettings.getInstance().getSettings().hdrTexture;
    const vsModule = device.createShaderModule({ label: 'gi_presentation_vs', code: vsCode });
    const fullscreen = (
      label: string,
      code: string,
      layouts: GPUBindGroupLayout[],
      blend?: GPUBlendState,
    ) =>
      device.createRenderPipelineAsync({
        label,
        layout: PipelineFactory.createPipelineLayout(`${label}_layout`, layouts),
        vertex: { module: vsModule, entryPoint: 'vs', buffers: Mesh.getVertexBufferLayout() },
        fragment: {
          module: device.createShaderModule({ label, code }),
          entryPoint: 'fs',
          targets: [{ format: hdrFormat, ...(blend ? { blend } : {}) }],
        },
        primitive: { topology: 'triangle-list' },
      });

    [
      this.tracePipeline,
      this.irradiancePipeline,
      this.visibilityPipeline,
      this.statePipeline,
      this.debugPipeline,
      this.ambientPipeline,
      this.blitPipeline,
      this.specularPipeline,
      this.resolvePipeline,
    ] = await Promise.all([
      compute('gi_probe_trace', traceCode, 'cs', [this.frameLayout, sceneLayout, this.traceLayout]),
      device.createComputePipelineAsync({
        label: 'gi_integrate_irradiance',
        layout: integrateLayout,
        compute: { module: integrateModule, entryPoint: 'irradiance' },
      }),
      device.createComputePipelineAsync({
        label: 'gi_integrate_visibility',
        layout: integrateLayout,
        compute: { module: integrateModule, entryPoint: 'visibility' },
      }),
      compute('gi_probe_state', stateCode, 'cs', [this.stateLayout]),
      compute('gi_debug', debugCode, 'cs', [
        this.frameLayout,
        sceneLayout,
        BindGroupFactory.getGBufferComputeLayout(),
        this.debugOutLayout,
      ]),
      fullscreen('gi_ambient', ambientCode, [
        BindGroupFactory.getCameraUniformsLayout(),
        BindGroupFactory.getGBufferLayout(),
        this.ambientLayout,
      ]),
      fullscreen('gi_blit', blitCode, [this.blitLayout]),
      // ambient_specular.tech with the REALTIME_GI permutation: same groups 0–2, GI in group 3.
      fullscreen(
        'gi_ambient_specular',
        specCode,
        [
          BindGroupFactory.getCameraUniformsLayout(),
          BindGroupFactory.getGBufferLayout(),
          BindGroupFactory.getSSRComposeUniformsLayout(),
          this.specularLayout,
        ],
        PipelineFactory.getAdditiveBlending(),
      ),
      compute('gi_resolve', resolveCode, 'cs', [
        this.frameLayout,
        BindGroupFactory.getGBufferComputeLayout(),
        this.resolveLayout,
      ]),
    ]);

    this.fullscreenQuad = await Mesh.getAsync('fullscreenquad.obj');
    this.brdfLUT = await Texture.getAsync('brdfLUT.png');
    this.paramsBuffer = GPUUtils.createBuffer(
      'gi_params',
      PARAMS_BYTES,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.temporalBuffer = GPUUtils.createBuffer(
      'gi_resolve_temporal',
      this.temporalData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.lightsBuffer = GPUUtils.createBuffer(
      'gi_lights',
      this.lightsData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.loaded = true;
  }

  // ─── Per frame ──────────────────────────────────────────────────────────────

  /**
   * Traces and integrates this frame's cascade. Returns false while GI can't light the frame
   * yet (pipelines or scene BVH still building) — the caller keeps the baked ambient.
   */
  public update(): boolean {
    if (!this.loaded) return false;
    if (!this.scene.isReady()) {
      if (!this.scene.isBuilding()) void this.scene.build();
      return false;
    }
    if (++this.frame % SCENE_CHECK_INTERVAL === 0 && this.scene.isStale()) void this.scene.build();
    this.scene.refreshMovedInstances();
    const sceneBindGroup = this.scene.getBindGroup();
    if (!sceneBindGroup) return false;

    const volumes = this.ensureVolumes();
    const camera = Engine.getRender().getMainCamera();
    this.batch = volumes.advance(camera.getPosition());
    this.gatherLights(camera.getPosition());
    this.writeParams(volumes);
    const frameBindGroup = this.ensureFrameBindGroup(volumes);
    if (!frameBindGroup) return false;

    const encoder = Render.getInstance().getCommandEncoder();
    const profiler = GPUProfiler.getInstance();
    const probes = this.batch.count;

    this.traceBindGroup ??= BindGroupFactory.createBindGroup('gi_trace_bg', this.traceLayout, [
      { binding: 0, resource: { buffer: volumes.raysBuffer } },
    ]);
    this.integrateBindGroup ??= BindGroupFactory.createBindGroup(
      'gi_integrate_bg',
      this.integrateLayout,
      [
        { binding: 0, resource: { buffer: volumes.raysBuffer } },
        { binding: 1, resource: volumes.irradianceScratchView },
        { binding: 2, resource: volumes.visibilityScratchView },
      ],
    );
    this.stateBindGroup ??= BindGroupFactory.createBindGroup('gi_state_bg', this.stateLayout, [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: volumes.raysBuffer } },
      { binding: 2, resource: { buffer: volumes.stateBuffer } },
      { binding: 3, resource: { buffer: volumes.volumesBuffer } },
    ]);

    const run = (label: string, fn: (pass: GPUComputePassEncoder) => void) => {
      const ts = profiler.getTimestampWrites(label);
      const pass = encoder.beginComputePass({ label, ...(ts ? { timestampWrites: ts } : {}) });
      fn(pass);
      pass.end();
    };

    run('GI Trace', (pass) => {
      pass.setPipeline(this.tracePipeline);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, sceneBindGroup);
      pass.setBindGroup(2, this.traceBindGroup!);
      pass.dispatchWorkgroups(Math.ceil((probes * volumes.config.raysPerProbe) / 64));
    });
    run('GI Integrate', (pass) => {
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, sceneBindGroup);
      pass.setBindGroup(2, this.integrateBindGroup!);
      pass.setPipeline(this.irradiancePipeline);
      pass.dispatchWorkgroups(probes);
      pass.setPipeline(this.visibilityPipeline);
      pass.dispatchWorkgroups(probes);
    });
    run('GI Probe State', (pass) => {
      pass.setPipeline(this.statePipeline);
      pass.setBindGroup(0, this.stateBindGroup!);
      pass.dispatchWorkgroups(Math.ceil(probes / 64));
    });
    volumes.copyBatch(encoder, this.batch);
    return true;
  }

  private ensureVolumes(): GIProbeVolumes {
    const config = this.volumeConfig();
    const key = JSON.stringify(config);
    if (!this.volumes || key !== this.volumeKey) {
      this.volumes?.destroy();
      this.volumes = new GIProbeVolumes(config);
      this.volumeKey = key;
      this.frameBindGroup = null;
      this.traceBindGroup = null;
      this.integrateBindGroup = null;
      this.stateBindGroup = null;
      this.specularBindGroup = null;
      this.ambientBindGroups.clear();
    }
    return this.volumes;
  }

  /**
   * The volume list, finest first: gi_volume components (local), then either one level volume
   * over the traced scene bounds (auto/level, when small enough) or camera cascades.
   */
  private volumeConfig(): GIVolumeConfig {
    const s = RealtimeGI.settings;
    const q = QUALITY[s.quality];
    const volumes: GIVolumeDesc[] = [...this.localVolumes()];

    const stats = this.scene.getStats();
    let level: GIVolumeDesc | null = null;
    if (s.volumes !== 'cascades' && stats) {
      // Coarsen up to 2× before giving up on a level volume.
      for (let spacing = s.spacing; spacing <= s.spacing * 2 + 1e-6 && !level; spacing *= 1.25) {
        const box = GIVolumeGrid.fit(stats.boundsMin, stats.boundsMax, spacing, LEVEL_MARGIN);
        if (box.probes <= MAX_LEVEL_PROBES || s.volumes === 'level') {
          level = { kind: 'level', dims: box.dims, origin: box.origin, spacing: box.spacing, weight: 4, fade: 2 };
        }
      }
    }
    if (level) {
      volumes.push(level);
    } else {
      const n = q.cascadeProbes;
      for (let c = 0; c < q.cascades; c++) {
        volumes.push({
          kind: 'cascade',
          dims: [n, n, n],
          spacing: s.spacing * 2 ** c,
          weight: CASCADE_WEIGHTS[c] ?? 1,
          fade: 2,
        });
      }
    }
    return { volumes, raysPerProbe: q.raysPerProbe, batchSize: q.batchSize };
  }

  /** gi_volume components as local volumes (finest spacing first). */
  private localVolumes(): GIVolumeDesc[] {
    const out: GIVolumeDesc[] = [];
    for (const comp of Engine.getEntities().getObjectManagerByName('gi_volume')?.getList() ?? []) {
      const box = (comp as GIVolumeComponent).getBox();
      let spacing = box.spacing;
      let grid = GIVolumeGrid.fit(box.min, box.max, spacing, 0);
      while (grid.probes > MAX_LOCAL_PROBES) {
        spacing *= 1.25;
        grid = GIVolumeGrid.fit(box.min, box.max, spacing, 0);
      }
      out.push({ kind: 'local', dims: grid.dims, origin: grid.origin, spacing: grid.spacing, weight: LOCAL_WEIGHT, fade: 1 });
    }
    return out.sort((a, b) => a.spacing - b.spacing).slice(0, GI_MAX_VOLUMES - 4);
  }

  private ensureFrameBindGroup(volumes: GIProbeVolumes): GPUBindGroup | null {
    const cameraBuffer = Engine.getRender().getMainCamera().getUniformBuffer();
    const probeSet = ProbeManager.getInstance().getProbeSetBuffer();
    if (!cameraBuffer || !probeSet) return null;
    const key = [cameraBuffer, probeSet, volumes];
    if (!this.frameBindGroup || key.some((v, i) => v !== this.frameBindGroupKey[i])) {
      this.frameBindGroupKey = key;
      this.frameBindGroup = BindGroupFactory.createBindGroup('gi_frame_bg', this.frameLayout, [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: cameraBuffer } },
        { binding: 2, resource: { buffer: probeSet } },
        { binding: 3, resource: { buffer: this.lightsBuffer } },
        { binding: 4, resource: { buffer: volumes.stateBuffer } },
        { binding: 5, resource: volumes.irradianceReadView },
        { binding: 6, resource: volumes.visibilityReadView },
        { binding: 7, resource: SamplerLibrary.simpleSampler! },
        { binding: 8, resource: { buffer: volumes.volumesBuffer } },
      ]);
    }
    return this.frameBindGroup;
  }

  /** The MAX_LIGHTS point/spot lights nearest the camera (by distance to their sphere). */
  private gatherLights(cameraPos: vec3): void {
    const lights = this.lightRefs;
    const order = this.lightOrder;
    const dist = this.lightDist;
    lights.length = 0;
    const entities = Engine.getEntities();
    for (const comp of entities.getObjectManagerByName('point_light')?.getList() ?? []) {
      const pl = comp as PointLightComponent;
      if (pl.getIntensity() > 0) lights.push(pl);
    }
    for (const comp of entities.getObjectManagerByName('spot_light')?.getList() ?? []) {
      const sl = comp as SpotLightComponent;
      if (sl.getIntensity() > 0) lights.push(sl);
    }
    order.length = lights.length;
    dist.length = lights.length;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]!;
      const pos = l instanceof SpotLightComponent ? l.getCamera().getPosition() : l.getWorldPosition();
      dist[i] = vec3.distance(pos, cameraPos) - l.getRadius();
      order[i] = i;
    }
    if (lights.length > MAX_LIGHTS) order.sort(this.byLightDistance);

    const data = this.lightsData;
    this.lightCount = Math.min(MAX_LIGHTS, lights.length);
    for (let i = 0; i < this.lightCount; i++) {
      const l = lights[order[i]!]!;
      const o = i * LIGHT_FLOATS;
      const col = l.getColor();
      const k = l.getIntensity();
      const isSpot = l instanceof SpotLightComponent;
      const pos = isSpot ? l.getCamera().getPosition() : l.getWorldPosition();
      data[o] = pos[0]!;
      data[o + 1] = pos[1]!;
      data[o + 2] = pos[2]!;
      data[o + 3] = l.getRadius();
      data[o + 4] = col[0]! * k;
      data[o + 5] = col[1]! * k;
      data[o + 6] = col[2]! * k;
      data[o + 7] = l.getStartFalloff();
      if (isSpot) {
        const dir = l.getCamera().getFront();
        data[o + 8] = dir[0]!;
        data[o + 9] = dir[1]!;
        data[o + 10] = dir[2]!;
        data[o + 11] = Math.cos(l.getCamera().getFov() * 0.5);
      } else {
        data[o + 8] = data[o + 9] = data[o + 10] = 0;
        data[o + 11] = -2; // point light
      }
    }
    if (this.lightCount > 0) {
      GPUUtils.writeBuffer(this.lightsBuffer, 0, data.subarray(0, this.lightCount * LIGHT_FLOATS));
    }
  }

  private writeParams(volumes: GIProbeVolumes): void {
    const s = RealtimeGI.settings;
    const f = this.paramsF;
    const u = this.paramsU;
    u.set([this.frame, this.lightCount, GI_DEBUG_VIEWS[s.debugView], (s.multiBounce ? 1 : 0) | (this.mode === 'compare' ? 2 : 0)], 0);
    u.set([volumes.tilesPerRow, volumes.volumeCount, Math.min(volumes.config.raysPerProbe, GI_MAX_RAYS), this.batch.volume], 4);
    u.set([this.batch.first, this.batch.count, 0, 0], 8);

    quat.random(this.rotationQuat);
    mat4.fromQuat(this.rayRotation, this.rotationQuat);
    f.set(this.rayRotation, 12);

    const sun = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList()[0] as DirectionalLightComponent | undefined;
    if (sun) {
      const dir = sun.getLightDirectionToSource();
      const col = sun.getColor();
      const k = sun.getIntensity();
      f.set([dir[0]!, dir[1]!, dir[2]!, 1], 28);
      f.set([col[0]! * k, col[1]! * k, col[2]! * k, 0], 32);
    } else {
      f.fill(0, 28, 36);
    }
    // The hysteresis setting holds for a probe traced every 2 frames; probes traced less often
    // blend more per update so every volume reacts in similar time — capped at 2× so rarely
    // traced volumes still average enough rays (noise matters more there than latency).
    const hysteresis = Math.pow(s.hysteresis, Math.min(Math.max(this.batch.interval / 2, 1), 2));
    f.set([hysteresis, s.skyIntensity, s.giIntensity, s.compareSplit], 36);
    f.set([s.normalBias, s.viewBias, s.rayLength, s.bounce], 40);
    const [iw, ih] = volumes.irradianceAtlasSize;
    const [vw, vh] = volumes.visibilityAtlasSize;
    f.set([iw, ih, vw, vh], 44);
    const ambient = Engine.getEnvironmentManager().getAmbientLightData();
    f.set([ambient.globalFactor, ambient.diffuseFactor, 0, 0], 48);
    GPUUtils.writeBuffer(this.paramsBuffer, 0, f);
  }

  // ─── Ambient pass ───────────────────────────────────────────────────────────

  /**
   * Same contract as AmbientLight.renderDiffuse: clears accLight to ambient + self-illumination.
   * First resolves the probe irradiance at reduced resolution (shared with the specular pass).
   */
  public renderDiffuse(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    aoResult: GPUTextureView,
    gBufferComputeBindGroup: GPUBindGroup,
  ): void {
    const resolveView = this.resolve(gBufferComputeBindGroup);
    const probeSet = ProbeManager.getInstance().getProbeSetBuffer();
    const key = [resolveView, probeSet];
    if (key.some((v, i) => v !== this.ambientKey[i])) {
      this.ambientBindGroups.clear();
      this.ambientKey = key;
    }
    let bindGroup = this.ambientBindGroups.get(aoResult);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup('gi_ambient_bg', this.ambientLayout, [
        { binding: 0, resource: aoResult },
        { binding: 1, resource: SamplerLibrary.simpleSampler! },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
        { binding: 3, resource: this.brdfLUT.getTextureView()! },
        { binding: 4, resource: { buffer: probeSet } },
        { binding: 5, resource: resolveView },
      ]);
      this.ambientBindGroups.set(aoResult, bindGroup);
    }

    const desc = GPUUtils.createRenderPassDescriptor('gi ambient render pass', [
      GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store'),
    ]);
    const ts = GPUProfiler.getInstance().getTimestampWrites('GI Ambient');
    if (ts) desc.timestampWrites = ts;
    const pass = Render.getInstance().getCommandEncoder().beginRenderPass(desc);
    GPUUtils.configureViewportAndScissor(pass);
    pass.setPipeline(this.ambientPipeline);
    this.fullscreenQuad.activate(pass);
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, bindGroup);
    this.fullscreenQuad.renderGroup(pass);
    pass.end();
  }

  /**
   * Probe irradiance + specular scale for the G-buffer at RealtimeGI.settings.resolution,
   * temporally filtered against last frame's result.
   */
  private resolve(gBufferComputeBindGroup: GPUBindGroup): GPUTextureView {
    const scale = RealtimeGI.settings.resolution;
    const width = Math.max(1, Math.ceil(Render.width * scale));
    const height = Math.max(1, Math.ceil(Render.height * scale));
    const current = this.resolveTargets[0]?.color;
    if (!current || current.width !== width || current.height !== height) {
      this.createResolveTargets(width, height);
    }

    // History: last frame's camera, valid unless the targets were just (re)created.
    const camera = Engine.getRender().getMainCamera();
    const t = this.temporalData;
    t.set(this.prevViewProj, 0);
    t.set([this.prevCameraPos[0]!, this.prevCameraPos[1]!, this.prevCameraPos[2]!, this.historyValid ? 1 : 0], 16);
    t.set([RealtimeGI.settings.temporal, 0, 0, 0], 20);
    GPUUtils.writeBuffer(this.temporalBuffer, 0, t);

    const p = this.resolveParity;
    const encoder = Render.getInstance().getCommandEncoder();
    const ts = GPUProfiler.getInstance().getTimestampWrites('GI Resolve');
    const pass = encoder.beginComputePass({ label: 'GI Resolve', ...(ts ? { timestampWrites: ts } : {}) });
    pass.setPipeline(this.resolvePipeline);
    pass.setBindGroup(0, this.frameBindGroup!);
    pass.setBindGroup(1, gBufferComputeBindGroup);
    pass.setBindGroup(2, this.resolveBindGroups[p]!);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();

    mat4.copy(this.prevViewProj, camera.getViewProjection());
    vec3.copy(this.prevCameraPos, camera.getPosition());
    this.historyValid = true;
    this.resolveParity = 1 - p;
    this.resolveView = this.resolveTargets[p]!.colorView;
    this.specularBindGroup = null;
    return this.resolveView;
  }

  private createResolveTargets(width: number, height: number): void {
    this.destroyResolveTargets();
    const device = GPUUtils.getDevice();
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    for (let i = 0; i < 2; i++) {
      const color = device.createTexture({ label: `gi_resolve_${i}`, size: { width, height }, format: 'rgba16float', usage });
      const distance = device.createTexture({ label: `gi_resolve_dist_${i}`, size: { width, height }, format: 'r32float', usage });
      this.resolveTargets.push({ color, distance, colorView: color.createView() });
    }
    const views = this.resolveTargets.map((r) => ({ color: r.colorView, distance: r.distance.createView() }));
    this.resolveBindGroups = [0, 1].map((i) =>
      BindGroupFactory.createBindGroup(`gi_resolve_bg_${i}`, this.resolveLayout, [
        { binding: 0, resource: views[i]!.color },
        { binding: 1, resource: views[i]!.distance },
        { binding: 2, resource: views[1 - i]!.color },
        { binding: 3, resource: views[1 - i]!.distance },
        { binding: 4, resource: { buffer: this.temporalBuffer } },
      ]),
    );
    this.resolveParity = 0;
    this.historyValid = false;
  }

  private destroyResolveTargets(): void {
    for (const r of this.resolveTargets) {
      r.color.destroy();
      r.distance.destroy();
    }
    this.resolveTargets = [];
    this.resolveBindGroups = [];
    this.resolveView = null;
  }

  /** Pipeline + group 3 for AmbientLight.renderSpecular (GI-scaled reflections). */
  public getSpecularOverride(): { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup } | null {
    if (!this.resolveView) return null;
    this.specularBindGroup ??= BindGroupFactory.createBindGroup('gi_specular_bg', this.specularLayout, [
      { binding: 0, resource: this.resolveView },
      { binding: 1, resource: SamplerLibrary.simpleSampler! },
    ]);
    return { pipeline: this.specularPipeline, bindGroup: this.specularBindGroup };
  }

  // ─── Debug views ────────────────────────────────────────────────────────────

  /** Replaces accLight with the selected debug view (end of the deferred frame). */
  public renderDebugOverlay(rtAccLight: GPUTextureView, gBufferComputeBindGroup: GPUBindGroup): void {
    if (RealtimeGI.settings.debugView === 'none' || !this.frameBindGroup) return;
    const sceneBindGroup = this.scene.getBindGroup();
    if (!sceneBindGroup) return;

    const width = Render.width;
    const height = Render.height;
    if (!this.debugTexture || this.debugTexture.width !== width || this.debugTexture.height !== height) {
      this.debugTexture?.destroy();
      this.debugTexture = GPUUtils.getDevice().createTexture({
        label: 'gi_debug',
        size: { width, height },
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const view = this.debugTexture.createView();
      this.debugOutBindGroup = BindGroupFactory.createBindGroup('gi_debug_out_bg', this.debugOutLayout, [
        { binding: 0, resource: view },
      ]);
      this.blitBindGroup = BindGroupFactory.createBindGroup('gi_blit_bg', this.blitLayout, [
        { binding: 0, resource: view },
        { binding: 1, resource: SamplerLibrary.simpleSampler! },
      ]);
    }

    const encoder = Render.getInstance().getCommandEncoder();
    const cpass = encoder.beginComputePass({ label: 'GI Debug' });
    cpass.setPipeline(this.debugPipeline);
    cpass.setBindGroup(0, this.frameBindGroup);
    cpass.setBindGroup(1, sceneBindGroup);
    cpass.setBindGroup(2, gBufferComputeBindGroup);
    cpass.setBindGroup(3, this.debugOutBindGroup!);
    cpass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    cpass.end();

    const pass = encoder.beginRenderPass(
      GPUUtils.createRenderPassDescriptor('gi debug blit', [
        GPUUtils.createColorAttachment(rtAccLight, 'clear', 'store'),
      ]),
    );
    GPUUtils.configureViewportAndScissor(pass);
    pass.setPipeline(this.blitPipeline);
    this.fullscreenQuad.activate(pass);
    pass.setBindGroup(0, this.blitBindGroup!);
    this.fullscreenQuad.renderGroup(pass);
    pass.end();
  }

  // ─── Editor ─────────────────────────────────────────────────────────────────

  /** Tunables folder (lil-gui). Works without an instance: the settings are static. */
  public static renderSettingsInMenu(folder: any): void {
    const s = RealtimeGI.settings;
    folder.add(s, 'debugView', Object.keys(GI_DEBUG_VIEWS)).name('Debug View').listen();
    folder.add(s, 'compareSplit', 0, 1).name('Compare Split').listen();
    folder.add(s, 'resolution', [0.25, 0.5, 1]).name('Resolve Resolution').listen();
    folder.add(s, 'temporal', 0, 0.97).name('Temporal Filter').listen();
    folder.add(s, 'quality', ['high', 'low']).name('Quality').listen();
    folder.add(s, 'volumes', ['auto', 'level', 'cascades']).name('Probe Volumes').listen();
    folder.add(s, 'spacing', 0.25, 4, 0.25).name('Probe Spacing (m)').listen();
    folder.add(s, 'giIntensity', 0, 4).name('GI Intensity').listen();
    folder.add(s, 'skyIntensity', 0, 4).name('Sky Intensity').listen();
    folder.add(s, 'multiBounce').name('Multi-Bounce').listen();
    folder.add(s, 'bounce', 0, 1).name('Bounce Strength').listen();
    folder.add(s, 'hysteresis', 0, 0.99).name('Hysteresis').listen();
    folder.add(s, 'normalBias', 0, 1).name('Normal Bias').listen();
    folder.add(s, 'viewBias', 0, 1).name('View Bias').listen();
  }

  public destroy(): void {
    this.scene.destroy();
    this.volumes?.destroy();
    this.volumes = null;
    this.debugTexture?.destroy();
    this.debugTexture = null;
    this.destroyResolveTargets();
    this.temporalBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.lightsBuffer?.destroy();
    this.frameBindGroup = null;
    this.traceBindGroup = null;
    this.integrateBindGroup = null;
    this.stateBindGroup = null;
    this.specularBindGroup = null;
    this.ambientBindGroups.clear();
    this.loaded = false;
  }
}

/** Probe grid covering a world box: min probe coordinate, probes per axis, spacing. */
const GIVolumeGrid = {
  fit(
    min: ArrayLike<number>,
    max: ArrayLike<number>,
    spacing: number,
    margin: number,
  ): { origin: [number, number, number]; dims: [number, number, number]; spacing: number; probes: number } {
    const sp = Math.round(spacing * 1000) / 1000;
    const origin = [0, 1, 2].map((k) => Math.floor(min[k]! / sp) - margin) as [number, number, number];
    const dims = [0, 1, 2].map((k) => Math.max(2, Math.ceil(max[k]! / sp) + margin - origin[k]! + 1)) as [
      number,
      number,
      number,
    ];
    return { origin, dims, spacing: sp, probes: dims[0] * dims[1] * dims[2] };
  },
};
