import { mat4, vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ParticleSystemComponentData } from '../../types/ParticleSystemComponentData.type';
import { MeshData } from '../../types/MeshData.type';
import { Engine } from '../../core/engine/Engine';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { ProbeManager } from '../../renderer/core/managers/ProbeManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { TiledLightManager } from '../../renderer/core/managers/TiledLightManager';
import { DirectionalLightComponent } from './DirectionalLightComponent';
import {
  CURVE_SAMPLES,
  FACINGS,
  FLIPBOOK_MODES,
  ParticleConfig,
  SPAWN_SHAPES,
  bakeParticleCurves,
  normalizeParticleConfig,
} from './particles/ParticleConfig';
import { buildParticleEditor } from './particles/ParticleEditor';

/** Ráfaga de partículas (burst). Lo que no se indica sale de la configuración del emisor. */
export interface ParticleBurstOptions {
  /** Velocidad base de esta ráfaga (en vez de init.velocity): p.ej. la dirección de un golpe. */
  velocity?: vec3;
  /** Las partículas mueren al bajar de esta altura (el suelo donde caen). */
  floorY?: number;
  /** Escala del tamaño de las partículas de esta ráfaga. Default 1. */
  sizeScale?: number;
}

interface QueuedBurst {
  count: number;
  position: vec3 | null;
  velocity: vec3 | null;
  floorY: number;
  sizeScale: number;
}

interface SimPipelines {
  update: GPUComputePipeline;
  spawn: GPUComputePipeline;
}

/** floorY de las partículas sin suelo. */
const NO_FLOOR = -1e9;
const PARTICLE_BYTES = 48;
const SPAWN_PARAMS_BYTES = 160; // SpawnParams (particle_spawn.cs)
const SIM_PARAMS_BYTES = 208; // SimParams (particle_update.cs)
const RENDER_PARAMS_FLOATS = 28; // ParticleRenderParams (common/particles.wgsl), 112 bytes
const CURVES_FLOATS = CURVE_SAMPLES * 4 + CURVE_SAMPLES; // ParticleCurves, 640 bytes
const DEG = Math.PI / 180;

/**
 * Sistema de partículas en GPU, organizado en módulos como un emisor de Niagara
 * (ParticleConfig): emitter → spawn (formas) → init → forces (gravedad, drag, curl noise,
 * vórtice, atractor) → overLife (curvas de color y tamaño) → render (sprite con facing y
 * flipbook, o ribbon) → lights (las partículas más grandes iluminan la escena, tiled).
 *
 * Los compute de spawn/update se compilan con los #define de los módulos activos (una
 * pipeline por combinación, compartida). Todo es editable en vivo desde el F2: los valores
 * se suben cada frame; los cambios de estructura (capacidad, material, ribbon, módulos
 * compilados) reconstruyen el emisor.
 */
export class ParticleSystemComponent extends Component {
  private config!: ParticleConfig;

  // ── Recursos GPU ─────────────────────────────────────────────────────────────
  private mesh!: Mesh;
  private material!: Material;
  private transform!: TransformComponent;
  private particleBuffer: GPUBuffer | null = null;
  private indirectDrawBuffer: GPUBuffer | null = null;
  private freeListBuffer: GPUBuffer | null = null;
  private freeListCountBuffer: GPUBuffer | null = null;
  private historyBuffer: GPUBuffer | null = null;
  private curvesBuffer: GPUBuffer | null = null;
  private renderParamsBuffer: GPUBuffer | null = null;
  private simParamsBuffer: GPUBuffer | null = null;
  private spawnParamsBuffer: GPUBuffer | null = null;
  private emitterLightCountBuffer: GPUBuffer | null = null;
  /** Sustitutos de los buffers de luces mientras no hay TiledLightManager (o sin módulo). */
  private dummyLightsBuffer: GPUBuffer | null = null;
  private dummyLightCountBuffer: GPUBuffer | null = null;
  private pipelines: SimPipelines | null = null;
  private updateBindGroup: GPUBindGroup | null = null;
  private spawnBindGroup: GPUBindGroup | null = null;
  private computeDeps: unknown[] = [];
  private renderBindGroup: GPUBindGroup | null = null;
  private renderDeps: unknown[] = [];
  private renderComponent: RenderComponent | null = null;
  /** Técnica LIT (sol + sombras + probes + niebla por partícula). */
  private lit = false;
  /** Puntos de estela reservados por partícula (0 = sprite). */
  private trailLength = 0;
  private lightsCompiled = false;
  private ready = false;
  /** Cada build invalida a los anteriores que sigan cargando. */
  private generation = 0;
  private rebuilding: Promise<void> | null = null;
  private rebuildQueued = false;
  /** dispose() ya llamado: si la carga asíncrona termina después, no se registra. */
  private disposed = false;
  private curvesDirty = true;

  // ── Emisión ─────────────────────────────────────────────────────────────────
  private spawnAccumulator = 0;
  private trailTimer = 0;
  private time = 0;
  /** Una por frame: comparten el uniform de spawn (cada una con su posición y velocidad). */
  private burstQueue: QueuedBurst[] = [];
  private emitting = true;
  private oneShotFired = false;

  // ── Staging CPU (sin allocations por frame) ──────────────────────────────────
  private spawnParams = new ArrayBuffer(SPAWN_PARAMS_BYTES);
  private spawnF32 = new Float32Array(this.spawnParams);
  private spawnU32 = new Uint32Array(this.spawnParams);
  private simParams = new ArrayBuffer(SIM_PARAMS_BYTES);
  private simF32 = new Float32Array(this.simParams);
  private simU32 = new Uint32Array(this.simParams);
  private renderParams = new Float32Array(RENDER_PARAMS_FLOATS);
  private curves = new Float32Array(CURVES_FLOATS);
  private zeroU32 = new Uint32Array(1);
  private emitterMatrix = mat4.create();
  private tmpMat = mat4.create();
  private tmpMat2 = mat4.create();
  private tmpVec = vec3.create();

  private static computeLayout: GPUBindGroupLayout | null = null;
  private static pipelineCache = new Map<string, Promise<SimPipelines>>();
  private static ribbonMaterials = new Map<string, Promise<Material>>();
  private static ribbonMeshes = new Map<number, Promise<Mesh>>();

  public override async load(data: unknown): Promise<void> {
    this.config = normalizeParticleConfig(data as ParticleSystemComponentData);
    this.emitting = this.config.emitter.emitting && !this.config.emitter.oneShot;
    this.transform = this.getOwner().getComponent('transform') as TransformComponent;
    await this.build();
  }

  /** Configuración viva (la edita el F2). */
  public getConfig(): ParticleConfig {
    return this.config;
  }

  /** Las curvas de vida cambiaron: se vuelven a hornear. */
  public markCurvesDirty(): void {
    this.curvesDirty = true;
  }

  /**
   * Reconstruye el emisor con la configuración actual (capacidad, material, renderer o
   * módulos compilados). Las partículas vivas se pierden.
   */
  public rebuild(): void {
    if (this.rebuilding) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuilding = this.build()
      .catch((e) => console.error('[particle_system] rebuild failed:', e))
      .finally(() => {
        this.rebuilding = null;
        if (this.rebuildQueued) {
          this.rebuildQueued = false;
          this.rebuild();
        }
      });
  }

  /** Vuelve a disparar el oneShot / limpia las partículas (F2 → Restart). */
  public restart(): void {
    this.oneShotFired = false;
    this.rebuild();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Build
  // ─────────────────────────────────────────────────────────────────────────────

  private simDefines(): string[] {
    const f = this.config.forces;
    const defines: string[] = [];
    if (f.curlNoise.enabled) defines.push('CURL_NOISE');
    if (f.vortex.enabled) defines.push('VORTEX');
    if (f.attractor.enabled) defines.push('ATTRACTOR');
    if (this.config.render.renderer === 'ribbon') defines.push('RIBBON');
    if (this.config.lights.enabled) defines.push('LIGHTS');
    return defines;
  }

  private async build(): Promise<void> {
    const gen = ++this.generation;
    const c = this.config;
    const ribbon = c.render.renderer === 'ribbon';
    const trailLength = ribbon ? c.render.ribbon.segments : 0;

    const [material, mesh, pipelines] = await Promise.all([
      ribbon ? ParticleSystemComponent.getRibbonMaterial(c.material) : Material.get(c.material),
      ribbon ? ParticleSystemComponent.getRibbonMesh(trailLength) : Mesh.getAsync('quad.obj'),
      ParticleSystemComponent.getPipelines(this.simDefines()),
    ]);
    if (gen !== this.generation || this.disposed) return;

    // Lo anterior deja de dibujarse antes de destruir sus buffers.
    this.releaseGPU();

    const device = GPUUtils.getDevice();
    const max = Math.max(1, Math.floor(c.maxParticles));
    this.material = material;
    this.mesh = mesh;
    this.pipelines = pipelines;
    this.trailLength = trailLength;
    this.lightsCompiled = c.lights.enabled;
    this.lit = material.getTechnique()?.usesLayout(PipelineBindGroupLayouts.PARTICLE_LIT_UNIFORMS) ?? false;

    const storage = (label: string, size: number, usage = 0): GPUBuffer =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage });
    const uniform = (label: string, size: number): GPUBuffer =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Todas muertas al empezar (alive = 0): un buffer a ceros.
    this.particleBuffer = storage('particle_storage_buffer', max * PARTICLE_BYTES);

    // instanceCount fijo = capacidad: el VS descarta las muertas.
    this.indirectDrawBuffer = device.createBuffer({
      label: 'particle_indirect_buffer',
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indirectDrawBuffer, 0, new Uint32Array([mesh.getIndexCount() || 6, max, 0, 0, 0]));

    // Free list: al principio todos los huecos están libres.
    this.freeListBuffer = storage('particle_free_list', max * 4);
    device.queue.writeBuffer(this.freeListBuffer, 0, Uint32Array.from({ length: max }, (_, i) => i));
    this.freeListCountBuffer = storage('particle_free_list_count', 4);
    device.queue.writeBuffer(this.freeListCountBuffer, 0, new Uint32Array([max]));

    this.historyBuffer = storage('particle_trail_history', Math.max(16, max * trailLength * 16));
    this.curvesBuffer = uniform('particle_curves', CURVES_FLOATS * 4);
    this.renderParamsBuffer = uniform('particle_render_params', RENDER_PARAMS_FLOATS * 4);
    this.simParamsBuffer = uniform('particle_sim_params', SIM_PARAMS_BYTES);
    this.spawnParamsBuffer = uniform('particle_spawn_params', SPAWN_PARAMS_BYTES);
    this.emitterLightCountBuffer = storage('particle_emitter_light_count', 4);
    this.dummyLightsBuffer = storage('particle_dummy_lights', 48);
    this.dummyLightCountBuffer = storage('particle_dummy_light_count', 4);
    this.curvesDirty = true;
    this.computeDeps = [];
    this.renderDeps = [];
    this.spawnAccumulator = 0;
    this.trailTimer = 0;
    this.ready = true;
    // La key se registra en update(), cuando existen todos los recursos que lee (profundidad,
    // sol, niebla…).
  }

  private static async getPipelines(defines: string[]): Promise<SimPipelines> {
    const key = [...defines].sort().join(',');
    let promise = this.pipelineCache.get(key);
    if (!promise) {
      promise = (async () => {
        const device = GPUUtils.getDevice();
        const layout = device.createPipelineLayout({
          label: 'particle_sim_pipeline_layout',
          bindGroupLayouts: [this.getComputeLayout()],
        });
        const [updateCode, spawnCode] = await Promise.all([
          ResourceManager.loadShader('particles/particle_update.cs', defines),
          ResourceManager.loadShader('particles/particle_spawn.cs'),
        ]);
        const [update, spawn] = await Promise.all([
          device.createComputePipelineAsync({
            label: `particle_update${key ? `#${key}` : ''}`,
            layout,
            compute: { module: device.createShaderModule({ label: 'particle_update_cs', code: updateCode }), entryPoint: 'main' },
          }),
          device.createComputePipelineAsync({
            label: 'particle_spawn',
            layout,
            compute: { module: device.createShaderModule({ label: 'particle_spawn_cs', code: spawnCode }), entryPoint: 'spawn' },
          }),
        ]);
        return { update, spawn };
      })();
      promise.catch(() => this.pipelineCache.delete(key));
      this.pipelineCache.set(key, promise);
    }
    return promise;
  }

  /** Bindings de los compute (particle_spawn.cs / particle_update.cs). */
  private static getComputeLayout(): GPUBindGroupLayout {
    if (!this.computeLayout) {
      const C = GPUShaderStage.COMPUTE;
      const rw: GPUBufferBindingLayout = { type: 'storage' };
      this.computeLayout = GPUUtils.getDevice().createBindGroupLayout({
        label: 'particle_sim_layout',
        entries: [
          { binding: 0, visibility: C, buffer: rw }, // particles
          { binding: 1, visibility: C, buffer: { type: 'uniform' } }, // SpawnParams / SimParams
          { binding: 2, visibility: C, buffer: rw }, // free list
          { binding: 3, visibility: C, buffer: rw }, // free list count
          { binding: 4, visibility: C, buffer: { type: 'uniform' } }, // ParticleCurves
          { binding: 5, visibility: C, buffer: rw }, // ribbon history
          { binding: 6, visibility: C, buffer: rw }, // tiled point lights
          { binding: 7, visibility: C, buffer: rw }, // particle light count (global)
          { binding: 8, visibility: C, buffer: rw }, // light count of this emitter
        ],
      });
    }
    return this.computeLayout;
  }

  /** El material con la permutación RIBBON de su técnica (uno por material base). */
  private static getRibbonMaterial(path: string): Promise<Material> {
    let promise = this.ribbonMaterials.get(path);
    if (!promise) {
      promise = (async () => {
        const data = await ResourceManager.loadMaterialData(path);
        return Material.get({ ...data, features: [...(data.features ?? []), 'RIBBON'] });
      })();
      promise.catch(() => this.ribbonMaterials.delete(path));
      this.ribbonMaterials.set(path, promise);
    }
    return promise;
  }

  /**
   * Tira de `segments` tramos: un par de vértices por punto de la estela. position.x = lado
   * (±0.5), position.y = índice del punto; uv = (largo, lado).
   */
  private static getRibbonMesh(segments: number): Promise<Mesh> {
    let promise = this.ribbonMeshes.get(segments);
    if (!promise) {
      const points = segments + 1;
      const positions = new Float32Array(points * 2 * 3);
      const normals = new Float32Array(points * 2 * 3);
      const uvs = new Float32Array(points * 2 * 2);
      const tangents = new Float32Array(points * 2 * 4);
      for (let k = 0; k < points; k++) {
        for (let s = 0; s < 2; s++) {
          const v = k * 2 + s;
          positions.set([s - 0.5, k, 0], v * 3);
          normals.set([0, 0, 1], v * 3);
          uvs.set([k / segments, s], v * 2);
          tangents.set([1, 0, 0, 1], v * 4);
        }
      }
      const indices = new Uint32Array(segments * 6);
      for (let k = 0; k < segments; k++) {
        const a = k * 2;
        indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], k * 6);
      }
      promise = Mesh.getAsync({
        attributes: { POSITION: positions, NORMAL: normals, TEXCOORD_0: uvs, TANGENT: tangents },
        indices,
      } as unknown as MeshData);
      this.ribbonMeshes.set(segments, promise);
    }
    return promise;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bind groups (se rehacen cuando cambia un recurso externo: resize, sombras, luces)
  // ─────────────────────────────────────────────────────────────────────────────

  private ensureComputeBindGroups(): void {
    const tiled = this.lightsCompiled ? Engine.getRender()?.getDeferredRenderer()?.getTiledLightManager() : undefined;
    const lights = tiled?.getPointLightBuffer() ?? this.dummyLightsBuffer!;
    const lightCount = tiled?.getParticleLightCountBuffer() ?? this.dummyLightCountBuffer!;
    const deps = [lights, lightCount];
    if (this.updateBindGroup && deps.every((d, i) => d === this.computeDeps[i])) return;
    this.computeDeps = deps;
    const device = GPUUtils.getDevice();
    const entries = (params: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: this.particleBuffer! } },
      { binding: 1, resource: { buffer: params } },
      { binding: 2, resource: { buffer: this.freeListBuffer! } },
      { binding: 3, resource: { buffer: this.freeListCountBuffer! } },
      { binding: 4, resource: { buffer: this.curvesBuffer! } },
      { binding: 5, resource: { buffer: this.historyBuffer! } },
      { binding: 6, resource: { buffer: lights } },
      { binding: 7, resource: { buffer: lightCount } },
      { binding: 8, resource: { buffer: this.emitterLightCountBuffer! } },
    ];
    const layout = ParticleSystemComponent.getComputeLayout();
    this.updateBindGroup = device.createBindGroup({ label: 'particle_update_bg', layout, entries: entries(this.simParamsBuffer!) });
    this.spawnBindGroup = device.createBindGroup({ label: 'particle_spawn_bg', layout, entries: entries(this.spawnParamsBuffer!) });
  }

  /**
   * @group(3) del render: partículas, parámetros, profundidad de la escena (soft particles),
   * historial y curvas; las LIT además sol + cascadas, probes y niebla. Registra la key la
   * primera vez y la rehace si alguno de esos recursos se recrea (resize, sombras).
   */
  private ensureRenderBindGroup(): void {
    const depthView = Engine.getRender()?.getDeferredRenderer()?.getLinearDepthView();
    if (!depthView) return;
    const common: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.particleBuffer! } },
      { binding: 1, resource: { buffer: this.renderParamsBuffer! } },
      { binding: 11, resource: depthView },
      { binding: 12, resource: { buffer: this.historyBuffer! } },
      { binding: 13, resource: { buffer: this.curvesBuffer! } },
    ];
    const device = GPUUtils.getDevice();

    if (!this.lit) {
      if (this.renderBindGroup && this.renderDeps[0] === depthView) return;
      this.renderDeps = [depthView];
      this.renderBindGroup = device.createBindGroup({
        label: 'particle_bindgroup',
        layout: BindGroupFactory.getParticleUniformsLayout(),
        entries: common,
      });
      this.registerRenderKey();
      return;
    }

    const sun = (Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [])[0] as
      | DirectionalLightComponent
      | undefined;
    const fog = Engine.getRender().getDeferredRenderer()?.getFroxelVolumetrics();
    const fogView = fog?.getIntegratedView();
    const fogParams = fog?.getFroxelUniformBuffer();
    if (!sun || !fogView || !fogParams) return;
    const probes = ProbeManager.getInstance();
    const deps: unknown[] = [
      depthView,
      sun.getUniformBuffer(),
      sun.getShadowDepthView(0),
      sun.getShadowDepthView(1),
      sun.getShadowDepthView(2),
      probes.getProbeSetBuffer(),
      fogView,
      fogParams,
    ];
    if (this.renderBindGroup && deps.every((d, i) => d === this.renderDeps[i])) return;
    this.renderDeps = deps;
    this.renderBindGroup = device.createBindGroup({
      label: 'particle_lit_bindgroup',
      layout: BindGroupFactory.getParticleLitUniformsLayout(),
      entries: [
        ...common,
        { binding: 2, resource: { buffer: sun.getUniformBuffer() } },
        { binding: 3, resource: sun.getShadowDepthView(0) },
        { binding: 4, resource: sun.getShadowDepthView(1) },
        { binding: 5, resource: sun.getShadowDepthView(2) },
        { binding: 6, resource: SamplerLibrary.shadows },
        { binding: 7, resource: { buffer: probes.getProbeSetBuffer() } },
        { binding: 8, resource: fogView },
        { binding: 9, resource: { buffer: fogParams } },
        { binding: 10, resource: SamplerLibrary.simpleSampler },
      ],
    });
    this.registerRenderKey();
  }

  private registerRenderKey(): void {
    if (this.renderComponent) RenderManagerV2.getInstance().delKeys(this.renderComponent);
    this.renderComponent = new RenderComponent();
    this.renderComponent.setOwner(this.getOwner());
    RenderManagerV2.getInstance().addKey(
      this.renderComponent,
      this.mesh,
      this.material,
      this.transform,
      true, // Skip CPU frustum culling
      Math.max(1, Math.floor(this.config.maxParticles)),
      undefined, // instanceBindGroup no se usa
      this.renderBindGroup!, // @group(3) del sistema de partículas
      this.indirectDrawBuffer!,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Uniforms
  // ─────────────────────────────────────────────────────────────────────────────

  private writeRenderParams(device: GPUDevice): void {
    const r = this.config.render;
    const a = this.renderParams;
    a[0] = this.config.init.sizeVariance;
    a[1] = r.spinSpeed;
    a[2] = r.tumbleSpeed;
    a[3] = r.flutter;
    a[4] = Math.max(1, Math.round(r.flipbook.grid[0]));
    a[5] = Math.max(1, Math.round(r.flipbook.grid[1]));
    a[6] = Math.max(0, FLIPBOOK_MODES.indexOf(r.flipbook.mode));
    a[7] = r.flipbook.fps;
    a[8] = r.nearFade;
    a[9] = Engine.getRender()?.getDeferredRenderer()?.getFroxelVolumetrics()?.isVolumetricEnabled() ? 1 : 0;
    a[10] = r.translucency;
    a[11] = r.shape === 'mist' ? 1 : 0;
    a[12] = r.stretch;
    a[13] = Math.max(0, FACINGS.indexOf(r.facing));
    a[14] = r.softDistance;
    a[15] = this.config.overLife.brightness;
    a[16] = r.axis[0];
    a[17] = r.axis[1];
    a[18] = r.axis[2];
    a[19] = this.config.worldSpace ? 0 : 1;
    a[20] = this.trailLength;
    a[21] = r.ribbon.interval;
    a[22] = r.ribbon.widthTail;
    a[23] = r.ribbon.alphaTail;
    a[24] = r.flipbook.blend ? 1 : 0;
    device.queue.writeBuffer(this.renderParamsBuffer!, 0, a);
  }

  /** Matriz mundo ← emisor (con la posición de la ráfaga si la trae). */
  private computeEmitterMatrix(position: vec3 | null): mat4 {
    const m = this.transform.getTransform().getWorldMatrix(this.emitterMatrix);
    if (position) {
      m[12] = position[0];
      m[13] = position[1];
      m[14] = position[2];
    }
    return m;
  }

  private writeSimParams(device: GPUDevice, dt: number, recordTrail: boolean): void {
    const c = this.config;
    const f = this.simF32;
    const u = this.simU32;
    const world = this.computeEmitterMatrix(null);
    // Espacio de las partículas → mundo: identidad si ya viven en el mundo.
    if (c.worldSpace) mat4.identity(this.tmpMat);
    else mat4.copy(this.tmpMat, world);
    f.set(this.tmpMat, 0);
    f[16] = c.forces.gravity[0];
    f[17] = c.forces.gravity[1];
    f[18] = c.forces.gravity[2];
    f[19] = dt;
    f[20] = c.forces.drag;
    f[21] = this.time;
    u[22] = recordTrail ? 1 : 0;
    u[23] = this.trailLength;
    f[24] = c.forces.curlNoise.strength;
    f[25] = c.forces.curlNoise.frequency;
    f[26] = c.forces.curlNoise.speed;
    f[27] = 0;
    // Vórtice y atractor: definidos en el espacio del emisor → espacio de las partículas.
    const toParticles = c.worldSpace ? world : mat4.identity(this.tmpMat2);
    const v = this.tmpVec;
    vec3.transformMat4(v, [0, 0, 0], toParticles);
    f.set(v, 28);
    f[31] = c.forces.vortex.strength;
    vec3.set(v, c.forces.vortex.axis[0], c.forces.vortex.axis[1], c.forces.vortex.axis[2]);
    vec3.transformMat4(v, v, toParticles);
    vec3.sub(v, v, [f[28]!, f[29]!, f[30]!]);
    if (vec3.length(v) < 1e-6) vec3.set(v, 0, 1, 0);
    vec3.normalize(v, v);
    f.set(v, 32);
    f[35] = c.forces.vortex.pull;
    const ap = c.forces.attractor.position;
    vec3.set(v, ap[0], ap[1], ap[2]);
    vec3.transformMat4(v, v, toParticles);
    f.set(v, 36);
    f[39] = c.forces.attractor.strength;
    f[40] = c.forces.attractor.radius;
    const l = c.lights;
    f[41] = l.fraction;
    u[42] = Math.max(0, Math.floor(l.max));
    f[43] = l.radius;
    f[44] = l.color[0];
    f[45] = l.color[1];
    f[46] = l.color[2];
    f[47] = l.intensity;
    f[48] = l.useParticleColor ? 1 : 0;
    u[49] = TiledLightManager.PARTICLE_LIGHT_BASE;
    u[50] = TiledLightManager.PARTICLE_LIGHT_SLOTS;
    f[51] = 0.15;
    device.queue.writeBuffer(this.simParamsBuffer!, 0, this.simParams);
  }

  private writeSpawnParams(device: GPUDevice, count: number, batch: QueuedBurst | null): void {
    const c = this.config;
    const f = this.spawnF32;
    const u = this.spawnU32;
    // World space: nacen en el mundo según el emisor; local: en su espacio (el VS lo transforma).
    if (c.worldSpace) f.set(this.computeEmitterMatrix(batch?.position ?? null), 0);
    else f.set(mat4.identity(this.tmpMat), 0);
    u[16] = count;
    u[17] = (Math.random() * 0xffffffff) >>> 0;
    u[18] = Math.max(0, SPAWN_SHAPES.indexOf(c.spawn.shape));
    u[19] = this.trailLength;
    f[20] = c.spawn.size[0];
    f[21] = c.spawn.size[1];
    f[22] = c.spawn.size[2];
    f[23] = c.spawn.radius;
    f[24] = Math.min(1, Math.max(0, c.spawn.innerRadius));
    f[25] = c.spawn.angle * DEG;
    f[26] = c.spawn.radialSpeed;
    f[27] = c.init.velocitySpread;
    const velocity = batch?.velocity ?? c.init.velocity;
    f[28] = velocity[0]!;
    f[29] = velocity[1]!;
    f[30] = velocity[2]!;
    f[31] = c.init.life;
    f[32] = c.init.lifeVariance[0];
    f[33] = c.init.lifeVariance[1];
    f[34] = batch?.floorY ?? NO_FLOOR;
    f[35] = batch?.sizeScale ?? 1;
    f[36] = c.init.speedVariance;
    device.queue.writeBuffer(this.spawnParamsBuffer!, 0, this.spawnParams);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Emite `count` partículas en la siguiente GPU frame (si hay varias ráfagas en cola, una
   * por frame). Si se proporciona `worldPos`, el emitter se teletransporta a esa posición
   * antes de emitir — ideal para efectos de impacto en world-space. `options`: velocidad,
   * suelo y tamaño propios de esta ráfaga (p.ej. la sangre de un golpe, hacia donde va).
   */
  public burst(count: number, worldPos?: vec3, options?: ParticleBurstOptions): void {
    if (worldPos && this.transform) {
      this.transform.getTransform().setLocalPosition(worldPos);
    }
    this.burstQueue.push({
      count,
      position: worldPos ? vec3.clone(worldPos) : null,
      velocity: options?.velocity ? vec3.clone(options.velocity) : null,
      floorY: options?.floorY ?? NO_FLOOR,
      sizeScale: options?.sizeScale ?? 1,
    });
  }

  public startEmitting(): void {
    this.emitting = true;
  }

  public stopEmitting(): void {
    this.emitting = false;
  }

  public isEmitting(): boolean {
    return this.emitting;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Frame
  // ─────────────────────────────────────────────────────────────────────────────

  public override update(deltaTime: number): void {
    if (!this.ready || !this.pipelines) return;
    const device = GPUUtils.getDevice();
    const c = this.config;
    this.time += deltaTime;

    this.ensureRenderBindGroup();
    this.ensureComputeBindGroups();

    if (this.curvesDirty) {
      this.curvesDirty = false;
      bakeParticleCurves(c, this.curves);
      device.queue.writeBuffer(this.curvesBuffer!, 0, this.curves);
    }
    this.writeRenderParams(device);

    // OneShot: dispara una sola vez en el primer update.
    if (c.emitter.oneShot && !this.oneShotFired) {
      this.oneShotFired = true;
      this.burst(c.emitter.burstCount);
    }

    // Una ráfaga en cola o, si no hay, la emisión continua (acumula las fracciones).
    const max = Math.max(1, Math.floor(c.maxParticles));
    if (this.emitting && !c.emitter.oneShot) this.spawnAccumulator += c.emitter.rate * deltaTime;
    const batch = this.burstQueue.shift() ?? null;
    let spawnCount = 0;
    if (batch) {
      spawnCount = Math.min(batch.count, max);
    } else if (this.spawnAccumulator >= 1) {
      spawnCount = Math.min(Math.floor(this.spawnAccumulator), max);
      this.spawnAccumulator -= Math.floor(this.spawnAccumulator);
    }

    // RIBBON: un punto de estela cada `interval` s.
    let recordTrail = false;
    if (this.trailLength > 0) {
      this.trailTimer += deltaTime;
      const interval = Math.max(1e-3, c.render.ribbon.interval);
      if (this.trailTimer >= interval) {
        recordTrail = true;
        this.trailTimer %= interval;
      }
    }

    this.writeSimParams(device, deltaTime, recordTrail);
    if (this.lightsCompiled) device.queue.writeBuffer(this.emitterLightCountBuffer!, 0, this.zeroU32);
    if (spawnCount > 0) this.writeSpawnParams(device, spawnCount, batch);

    const encoder = device.createCommandEncoder({ label: 'Particle System' });
    const pass = encoder.beginComputePass({ label: 'Particle Update + Spawn' });
    pass.setPipeline(this.pipelines.update);
    pass.setBindGroup(0, this.updateBindGroup!);
    pass.dispatchWorkgroups(Math.ceil(max / 64));
    if (spawnCount > 0) {
      pass.setPipeline(this.pipelines.spawn);
      pass.setBindGroup(0, this.spawnBindGroup!);
      pass.dispatchWorkgroups(Math.ceil(spawnCount / 64));
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  public override renderInMenu(folder?: any): void {
    if (!folder || !this.config) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Particle System');
    this._editorFolder.close();
    buildParticleEditor(this._editorFolder, this);
  }

  public override dispose(): void {
    this.disposed = true;
    this.generation++;
    this.releaseGPU();
  }

  /**
   * Deja de dibujarlo y libera sus buffers. Primero la key: si no, el siguiente frame usa
   * buffers destruidos y la GPU rechaza el submit entero (pantalla en negro).
   */
  private releaseGPU(): void {
    this.ready = false;
    if (this.renderComponent) RenderManagerV2.getInstance().delKeys(this.renderComponent);
    this.renderComponent = null;
    this.renderBindGroup = null;
    this.updateBindGroup = null;
    this.spawnBindGroup = null;
    for (const buffer of [
      this.particleBuffer,
      this.indirectDrawBuffer,
      this.freeListBuffer,
      this.freeListCountBuffer,
      this.historyBuffer,
      this.curvesBuffer,
      this.renderParamsBuffer,
      this.simParamsBuffer,
      this.spawnParamsBuffer,
      this.emitterLightCountBuffer,
      this.dummyLightsBuffer,
      this.dummyLightCountBuffer,
    ]) {
      buffer?.destroy();
    }
    this.particleBuffer = null;
    this.indirectDrawBuffer = null;
    this.freeListBuffer = null;
    this.freeListCountBuffer = null;
    this.historyBuffer = null;
    this.curvesBuffer = null;
    this.renderParamsBuffer = null;
    this.simParamsBuffer = null;
    this.spawnParamsBuffer = null;
    this.emitterLightCountBuffer = null;
    this.dummyLightsBuffer = null;
    this.dummyLightCountBuffer = null;
  }
}
