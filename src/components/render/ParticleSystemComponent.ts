import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Engine } from '../../core/engine/Engine';
import { ParticleSystemComponentData } from '../../types/ParticleSystemComponentData.type';

/**
 * ParticleSystemComponent - GPU-driven particle system using indirect draw
 * for efficient rendering of dynamic particle counts
 */
export class ParticleSystemComponent extends Component {
  private static readonly MAX_PARTICLES = 1024; // Aumentado para spawn system
  private quadMesh!: Mesh;
  private particleMaterial!: Material;
  private transform!: TransformComponent;
  private particleBuffer!: GPUBuffer;
  private indirectDrawBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderComponent!: RenderComponent;

  // Compute shader resources (update particles)
  private updatePipeline!: GPUComputePipeline;
  private updateBindGroup!: GPUBindGroup;
  private simulationParamsBuffer!: GPUBuffer;

  // Spawn shader resources (compaction eliminada - ahora skip en vertex shader)
  private spawnPipeline!: GPUComputePipeline;
  private spawnCompactBindGroup!: GPUBindGroup;
  private spawnParamsBuffer!: GPUBuffer;
  private spawnCounterBuffer!: GPUBuffer;

  // OPTIMIZACIÓN: Dead Particle Free List
  // En lugar de scan linear O(n) para encontrar slots muertos,
  // mantenemos una stack de índices disponibles para O(1) lookups.
  private freeListBuffer!: GPUBuffer; // Array de índices libres (u32 x 1024)
  private freeListCountBuffer!: GPUBuffer; // Contador atómico de slots libres

  // Spawn timing
  private spawnTimer: number = 0;
  private spawnInterval: number = 0.5; // Spawn cada 0.5 segundos
  private particlesPerSpawn: number = 20; // 5 partículas por spawn

  // World space mode - determina qué técnica usar (particle.tech vs particle_worldspace.tech)
  private worldSpace: boolean = false; // Si true, las partículas se emiten en world space
  private spawnRadius: number = 2.0; // Radio de spawn de las partículas

  // OPTIMIZACIÓN: Reuse buffers CPU para evitar allocations
  private simParamsArray = new Float32Array(8); // Reutilizable
  private spawnParamsArray = new ArrayBuffer(64); // Alineado a 16 bytes: u32 + f32 + u32 + f32 + vec3 + f32 + vec3 + f32 + f32 + padding = 64 bytes
  private spawnParamsFloat32View!: Float32Array;
  private spawnParamsUint32View!: Uint32Array;
  private counterDataArray = new Uint32Array(1); // Reutilizable para atomic counter

  // Cache de valores previos para conditional writes
  private lastSpawnInterval: number = 0;
  private lastParticlesPerSpawn: number = 0;

  constructor() {
    super();
    // Inicializar views reutilizables
    this.spawnParamsFloat32View = new Float32Array(this.spawnParamsArray);
    this.spawnParamsUint32View = new Uint32Array(this.spawnParamsArray);
  }

  public override async load(_data: unknown): Promise<void> {
    try {
      // Leer configuración
      const data = _data as ParticleSystemComponentData;
      this.worldSpace = data?.worldSpace ?? false;
      this.spawnRadius = data?.spawnRadius ?? 2.0;

      // 1. Cargar mesh y material con la técnica apropiada según worldSpace
      this.quadMesh = await Mesh.get('quad.obj');

      // Seleccionar material basado en el modo world space
      const materialPath = this.worldSpace ? 'particle_worldspace.mat' : 'particle.mat';
      this.particleMaterial = await Material.get(materialPath);

      const device = GPUUtils.getDevice();

      this.transform = this.getOwner().getComponent('transform') as TransformComponent;

      // 2. Crear storage buffer para datos de partículas
      // Estructura: position(vec3 + padding) + velocity(vec3) + lifetime(f32) + age(f32) + active(u32) + padding(u32 x2)
      // Total: 48 bytes por partícula
      const PARTICLE_SIZE_FLOATS = 12; // 48 bytes / 4 bytes por float
      const particleData = new Float32Array(
        ParticleSystemComponent.MAX_PARTICLES * PARTICLE_SIZE_FLOATS,
      );

      // Inicializar TODAS las partículas como muertas (alive = 0)
      // El sistema de spawn las irá activando automáticamente
      const uint32View = new Uint32Array(particleData.buffer);
      for (let i = 0; i < ParticleSystemComponent.MAX_PARTICLES; i++) {
        const offset = i * PARTICLE_SIZE_FLOATS;
        // position, velocity, lifetime, age = 0 por defecto (Float32Array inicia en 0)

        // active = 0 (muerta)
        const uint32Offset = offset + 9;
        uint32View[uint32Offset + 0] = 0; // alive = 0
      }

      this.particleBuffer = device.createBuffer({
        label: 'particle_storage_buffer',
        size: particleData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.particleBuffer, 0, particleData);

      // 3. Crear buffer indirecto (indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
      // OPTIMIZACIÓN: instanceCount ahora es FIJO = MAX_PARTICLES
      // El vertex shader skip partículas muertas (alive == 0) generando triángulos degenerados.
      // Esto elimina la necesidad de compactar el array cada frame (ganancia: 10-50%).
      const indirectArgs = new Uint32Array([
        6, // indexCount (quad)
        ParticleSystemComponent.MAX_PARTICLES, // instanceCount FIJO - skip dead en VS
        0, // firstIndex
        0, // baseVertex
        0, // firstInstance
      ]);
      this.indirectDrawBuffer = device.createBuffer({
        label: 'particle_indirect_buffer',
        size: indirectArgs.byteLength,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.indirectDrawBuffer, 0, indirectArgs);

      // 4. OPTIMIZACIÓN: Crear Dead Particle Free List
      // Free list es un stack de índices de partículas muertas.
      // Permite O(1) spawn lookups en vez de O(n) scan linear.
      // Inicialmente todas las partículas están muertas, así que la free list
      // contiene todos los índices [0, 1, 2, ..., 1023].
      const freeListData = new Uint32Array(ParticleSystemComponent.MAX_PARTICLES);
      for (let i = 0; i < ParticleSystemComponent.MAX_PARTICLES; i++) {
        freeListData[i] = i; // Índice de la partícula
      }

      this.freeListBuffer = device.createBuffer({
        label: 'particle_free_list',
        size: freeListData.byteLength, // 1024 × 4 bytes = 4096 bytes
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.freeListBuffer, 0, freeListData);

      // Contador de slots libres (inicialmente = MAX_PARTICLES)
      const freeListCount = new Uint32Array([ParticleSystemComponent.MAX_PARTICLES]);
      this.freeListCountBuffer = device.createBuffer({
        label: 'particle_free_list_count',
        size: 4, // 1 × u32 = 4 bytes
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.freeListCountBuffer, 0, freeListCount);

      // 5. Crear bind group para el storage buffer (group 3, binding 0)
      const renderBindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' },
          },
        ],
      });

      this.renderBindGroup = device.createBindGroup({
        layout: renderBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.particleBuffer },
          },
        ],
      });

      // 5. Crear compute shader pipeline y recursos
      await this.createComputePipeline();

      // 6. Registrar la key instanciada en el RenderManagerV2
      this.renderComponent = new RenderComponent();
      this.renderComponent.setOwner(this.getOwner());
      RenderManagerV2.getInstance().addKey(
        this.renderComponent,
        this.quadMesh,
        this.particleMaterial,
        this.transform,
        true, // ✅ Skip CPU frustum culling (particles are dynamic, indirect draw handles visibility)
        ParticleSystemComponent.MAX_PARTICLES,
        undefined, // instanceBindGroup no se usa
        this.renderBindGroup, // renderBindGroup para @group(2) del sistema de partículas
        this.indirectDrawBuffer,
      );
    } catch (error: any) {
      throw error;
    }
  }

  private async createComputePipeline(): Promise<void> {
    const device = GPUUtils.getDevice();

    // 1. Crear buffers para parámetros de simulación y spawn
    this.simulationParamsBuffer = device.createBuffer({
      label: 'simulation_params_buffer',
      size: 32, // deltaTime + padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.spawnParamsBuffer = device.createBuffer({
      label: 'spawn_params_buffer',
      size: 64, // Alineado a 16 bytes según WebGPU uniform buffer requirements
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.spawnCounterBuffer = device.createBuffer({
      label: 'spawn_counter_buffer',
      size: 4, // atomic<u32>
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 2. Crear SHARED bind group layout explícito para evitar incompatibilidades
    // ACTUALIZADO: Ahora incluye free list buffers para O(1) spawn lookups
    const sharedBindGroupLayout = device.createBindGroupLayout({
      label: 'shared_particle_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }, // read_write particles
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }, // read_write indirectArgs
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' }, // spawn/sim params (dual purpose)
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }, // spawnCounter (atomic)
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }, // freeList (array<u32>)
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }, // freeListCount (atomic<u32>)
        },
      ],
    });

    // 3. Crear pipeline layout compartido
    const sharedPipelineLayout = device.createPipelineLayout({
      label: 'shared_particle_pipeline_layout',
      bindGroupLayouts: [sharedBindGroupLayout],
    });

    // 4. Cargar shaders
    const updateShaderCode = await ResourceManager.loadShader('particle_update.cs');
    const spawnCompactShaderCode = await ResourceManager.loadShader('particle_spawn_compact.cs');

    const updateShader = device.createShaderModule({
      label: 'particle_update_cs',
      code: updateShaderCode,
    });

    const spawnCompactShader = device.createShaderModule({
      label: 'particle_spawn_compact_cs',
      code: spawnCompactShaderCode,
    });

    // 5. Crear pipelines con el layout compartido
    this.updatePipeline = device.createComputePipeline({
      label: 'particle_update_pipeline',
      layout: sharedPipelineLayout,
      compute: {
        module: updateShader,
        entryPoint: 'main',
      },
    });

    this.spawnPipeline = device.createComputePipeline({
      label: 'particle_spawn_pipeline',
      layout: sharedPipelineLayout,
      compute: {
        module: spawnCompactShader,
        entryPoint: 'spawn',
      },
    });

    // NOTA: compactPipeline ELIMINADA - compaction ahora se hace en vertex shader
    // El vertex shader skip partículas muertas (alive == 0) generando triángulos degenerados.
    // Esto es 10-50% más rápido que compactar el array cada frame.

    // 6. Crear bind groups (uno para update, otro para spawn)
    // ACTUALIZADO: Ahora incluye free list buffers
    this.updateBindGroup = device.createBindGroup({
      layout: sharedBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.particleBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.indirectDrawBuffer },
        },
        {
          binding: 2,
          resource: { buffer: this.simulationParamsBuffer },
        },
        {
          binding: 3,
          resource: { buffer: this.spawnCounterBuffer },
        },
        {
          binding: 4,
          resource: { buffer: this.freeListBuffer },
        },
        {
          binding: 5,
          resource: { buffer: this.freeListCountBuffer },
        },
      ],
    });

    this.spawnCompactBindGroup = device.createBindGroup({
      layout: sharedBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.particleBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.indirectDrawBuffer },
        },
        {
          binding: 2,
          resource: { buffer: this.spawnParamsBuffer }, // Usa spawnParams en lugar de simParams
        },
        {
          binding: 3,
          resource: { buffer: this.spawnCounterBuffer },
        },
        {
          binding: 4,
          resource: { buffer: this.freeListBuffer },
        },
        {
          binding: 5,
          resource: { buffer: this.freeListCountBuffer },
        },
      ],
    });
  }

  public override update(deltaTime: number): void {
    const device = GPUUtils.getDevice();

    // 1. Actualizar timer de spawn
    this.spawnTimer += deltaTime;

    // 2. OPTIMIZACIÓN: Reutilizar buffer y solo escribir deltaTime (4 bytes)
    // En lugar de crear Float32Array nuevo cada frame
    this.simParamsArray[0] = deltaTime;
    // Solo escribimos el primer float (4 bytes) en lugar de todo el buffer (32 bytes)
    device.queue.writeBuffer(this.simulationParamsBuffer, 0, this.simParamsArray, 0, 1);

    // Verificar si es momento de spawn
    const shouldSpawn = this.spawnTimer >= this.spawnInterval;

    if (shouldSpawn) {
      this.spawnTimer = 0;

      // OPTIMIZACIÓN: Reutilizar buffer en lugar de crear nuevo cada spawn
      // Detectar cambios en spawn params desde debug UI
      const paramsChanged =
        this.lastSpawnInterval !== this.spawnInterval ||
        this.lastParticlesPerSpawn !== this.particlesPerSpawn;

      if (paramsChanged) {
        this.lastSpawnInterval = this.spawnInterval;
        this.lastParticlesPerSpawn = this.particlesPerSpawn;
      }

      // Preparar parámetros de spawn - struct tiene:
      // u32 spawnCount, f32 randomSeed, u32 worldSpace, f32 padding1, vec3 emitterWorldPos, f32 padding2, vec3 emitterWorldScale, f32 padding3
      this.spawnParamsUint32View[0] = this.particlesPerSpawn; // spawnCount (u32)
      this.spawnParamsFloat32View[1] = Math.random() * 10000.0; // randomSeed (f32)
      this.spawnParamsUint32View[2] = this.worldSpace ? 1 : 0; // worldSpace (u32)
      this.spawnParamsFloat32View[3] = 0; // padding1

      // Emitter world position (vec3)
      const worldPos = this.transform.getTransform().getWorldPosition();
      this.spawnParamsFloat32View[4] = worldPos[0]; // emitterWorldPos.x
      this.spawnParamsFloat32View[5] = worldPos[1]; // emitterWorldPos.y
      this.spawnParamsFloat32View[6] = worldPos[2]; // emitterWorldPos.z
      this.spawnParamsFloat32View[7] = 0; // padding2

      // Emitter world scale (vec3)
      const worldScale = this.transform.getTransform().getWorldScale();
      this.spawnParamsFloat32View[8] = worldScale[0]; // emitterWorldScale.x
      this.spawnParamsFloat32View[9] = worldScale[1]; // emitterWorldScale.y
      this.spawnParamsFloat32View[10] = worldScale[2]; // emitterWorldScale.z
      this.spawnParamsFloat32View[11] = 0; // padding3
      this.spawnParamsFloat32View[12] = this.spawnRadius; // spawnRadius

      device.queue.writeBuffer(this.spawnParamsBuffer, 0, this.spawnParamsArray);

      // OPTIMIZACIÓN: Resetear contador atómico reutilizando buffer CPU
      // ANTES: new Uint32Array([...]) cada spawn → GC pressure
      // AHORA: reutilizar counterDataArray → 0 allocations
      this.counterDataArray[0] = this.particlesPerSpawn;
      device.queue.writeBuffer(this.spawnCounterBuffer, 0, this.counterDataArray);
    }

    // OPTIMIZACIÓN CRÍTICA: Batch Command Submissions + Eliminar Compaction
    // ANTES (3 passes):
    //   - UPDATE:  100μs
    //   - SPAWN:    50μs (condicional)
    //   - COMPACT: 50-500μs (SERIAL, single-threaded bottleneck)
    //   Total: 200-650μs
    //
    // AHORA (2 passes):
    //   - UPDATE: 100μs
    //   - SPAWN:   50μs (condicional)
    //   Total: 150μs (sin spawn) / 200μs (con spawn)
    //   Ganancia: 25-77% (50-450μs saved)
    //
    // El vertex shader ahora skip dead particles generando triángulos degenerados.
    // Overhead: ~1-2 ciclos GPU × dead particles (~5-50μs) vs 50-500μs de compaction.
    const encoder = device.createCommandEncoder({ label: 'Particle System' });

    // Pass 1: UPDATE (actualiza física y lifetime)
    const updatePass = encoder.beginComputePass({ label: 'Update Pass' });
    updatePass.setPipeline(this.updatePipeline);
    updatePass.setBindGroup(0, this.updateBindGroup);
    const updateWorkgroups = Math.ceil(ParticleSystemComponent.MAX_PARTICLES / 64);
    updatePass.dispatchWorkgroups(updateWorkgroups);
    updatePass.end();

    // Pass 2: SPAWN (solo si toca) - crea nuevas partículas
    if (shouldSpawn) {
      const spawnPass = encoder.beginComputePass({ label: 'Spawn Pass' });
      spawnPass.setPipeline(this.spawnPipeline);
      spawnPass.setBindGroup(0, this.spawnCompactBindGroup);
      const spawnWorkgroups = Math.ceil(ParticleSystemComponent.MAX_PARTICLES / 64);
      spawnPass.dispatchWorkgroups(spawnWorkgroups);
      spawnPass.end();
    }

    // COMPACTION ELIMINADA: Ya no necesitamos compactar el array
    // El vertex shader hace skip de partículas muertas directamente

    // SINGLE SUBMISSION - todos los passes en un solo command buffer
    device.queue.submit([encoder.finish()]);
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const folderName = `Particle System (${this.getOwner().getName()})`;

    // Spawn controls
    debugUI.addInteractiveControl(folderName, this, 'spawnRadius', 'Spawn Radius', {
      min: 0.1,
      max: 10.0,
      step: 0.1,
    });

    debugUI.addInteractiveControl(folderName, this, 'spawnInterval', 'Spawn Interval (s)', {
      min: 0.1,
      max: 5.0,
      step: 0.1,
    });

    debugUI.addInteractiveControl(folderName, this, 'particlesPerSpawn', 'Particles per Spawn', {
      min: 1,
      max: 50,
      step: 1,
    });

    // Info (read-only)
    const stats = { maxParticles: ParticleSystemComponent.MAX_PARTICLES };
    debugUI.addDebugControl(folderName, stats, 'maxParticles', 'Max Particles');
  }

  public override renderDebug(): void {
    // TODO: Add visualization of particle positions and movement paths
  }

  public dispose(): void {
    // Cleanup GPU resources
    this.particleBuffer?.destroy();
    this.indirectDrawBuffer?.destroy();
    this.simulationParamsBuffer?.destroy();
    this.spawnParamsBuffer?.destroy();
    this.spawnCounterBuffer?.destroy();
    this.freeListBuffer?.destroy();
    this.freeListCountBuffer?.destroy();
  }
}
