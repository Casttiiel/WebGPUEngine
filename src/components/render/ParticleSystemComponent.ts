import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Engine } from '../../core/engine/Engine';

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

  // Spawn/compact shader resources
  private spawnPipeline!: GPUComputePipeline;
  private compactPipeline!: GPUComputePipeline;
  private spawnCompactBindGroup!: GPUBindGroup;
  private spawnParamsBuffer!: GPUBuffer;
  private spawnCounterBuffer!: GPUBuffer;

  // Spawn timing
  private spawnTimer: number = 0;
  private spawnInterval: number = 1.5; // Spawn cada 0.5 segundos
  private particlesPerSpawn: number = 20; // 5 partículas por spawn

  // OPTIMIZACIÓN: Reuse buffers CPU para evitar allocations
  private simParamsArray = new Float32Array(8); // Reutilizable
  private spawnParamsArray = new ArrayBuffer(16); // Reutilizable
  private spawnParamsFloat32View!: Float32Array;
  private spawnParamsUint32View!: Uint32Array;

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
      // 1. Cargar mesh y material
      this.quadMesh = await Mesh.get('quad.obj');
      this.particleMaterial = await Material.get('particle.mat');
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
      const indirectArgs = new Uint32Array([
        6, // indexCount (quad)
        0, // instanceCount (empezamos con 0, el spawn las irá creando)
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

      // 4. Crear bind group para el storage buffer (group 3, binding 0)
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
        true, // instanciado
        ParticleSystemComponent.MAX_PARTICLES,
        this.renderBindGroup,
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
      size: 16, // spawnCount, randomSeed, padding x2
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.spawnCounterBuffer = device.createBuffer({
      label: 'spawn_counter_buffer',
      size: 4, // atomic<u32>
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 2. Crear SHARED bind group layout explícito para evitar incompatibilidades
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

    this.compactPipeline = device.createComputePipeline({
      label: 'particle_compact_pipeline',
      layout: sharedPipelineLayout,
      compute: {
        module: spawnCompactShader,
        entryPoint: 'compact',
      },
    });

    // 6. Crear bind groups (uno para update, otro para spawn/compact)
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

    // 3. Ejecutar UPDATE shader (actualiza física y lifetime)
    const updateEncoder = device.createCommandEncoder({ label: 'Particle Update' });
    const updatePass = updateEncoder.beginComputePass({ label: 'Update Pass' });

    updatePass.setPipeline(this.updatePipeline);
    updatePass.setBindGroup(0, this.updateBindGroup);

    const updateWorkgroups = Math.ceil(ParticleSystemComponent.MAX_PARTICLES / 64);
    updatePass.dispatchWorkgroups(updateWorkgroups);

    updatePass.end();
    device.queue.submit([updateEncoder.finish()]);

    // 4. Verificar si es momento de spawn
    if (this.spawnTimer >= this.spawnInterval) {
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

      // Preparar parámetros de spawn - struct tiene: u32 spawnCount, f32 randomSeed, f32 padding1, f32 padding2
      this.spawnParamsUint32View[0] = this.particlesPerSpawn; // spawnCount (u32)
      this.spawnParamsFloat32View[1] = Math.random() * 10000.0; // randomSeed (f32) - siempre cambia
      this.spawnParamsFloat32View[2] = 0; // padding1
      this.spawnParamsFloat32View[3] = 0; // padding2

      device.queue.writeBuffer(this.spawnParamsBuffer, 0, this.spawnParamsArray);

      // Resetear contador atómico (reutilizar array)
      const counterData = new Uint32Array([this.particlesPerSpawn]);
      device.queue.writeBuffer(this.spawnCounterBuffer, 0, counterData);

      // IMPORTANTE: Los writeBuffer se ejecutan en la queue, pero necesitamos
      // asegurarnos de que se completen ANTES del compute shader
      // Sin embargo, WebGPU garantiza el orden de operaciones en la misma queue

      // 5. Ejecutar SPAWN shader
      const spawnEncoder = device.createCommandEncoder({ label: 'Particle Spawn' });
      const spawnPass = spawnEncoder.beginComputePass({ label: 'Spawn Pass' });

      spawnPass.setPipeline(this.spawnPipeline);
      spawnPass.setBindGroup(0, this.spawnCompactBindGroup);

      const spawnWorkgroups = Math.ceil(ParticleSystemComponent.MAX_PARTICLES / 64);
      spawnPass.dispatchWorkgroups(spawnWorkgroups);

      spawnPass.end();
      device.queue.submit([spawnEncoder.finish()]);
    }

    // 6. Ejecutar COMPACT shader (ahora solo cuenta partículas vivas, no compacta)
    const compactEncoder = device.createCommandEncoder({ label: 'Particle Compact' });
    const compactPass = compactEncoder.beginComputePass({ label: 'Compact Pass' });

    compactPass.setPipeline(this.compactPipeline);
    compactPass.setBindGroup(0, this.spawnCompactBindGroup);

    compactPass.dispatchWorkgroups(1); // Single-threaded para evitar race conditions

    compactPass.end();
    device.queue.submit([compactEncoder.finish()]);
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const folderName = `Particle System (${this.getOwner().getName()})`;

    // Spawn controls
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
  }
}
