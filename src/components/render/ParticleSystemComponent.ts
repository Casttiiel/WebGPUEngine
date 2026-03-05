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
  // ── Capacidad (leída del prefab) ──────────────────────────────────────────────
  private maxParticles: number = 1024;

  // ── GPU resources ──────────────────────────────────────────────────────────────
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

  // Render params uniform buffer (startSize, endSize, startColor, endColor → VS)
  private particleRenderParamsBuffer!: GPUBuffer;

  // OPTIMIZACIÓN: Dead Particle Free List
  private freeListBuffer!: GPUBuffer;
  private freeListCountBuffer!: GPUBuffer;

  // ── Spawn timing ───────────────────────────────────────────────────────────────
  private spawnTimer: number = 0;
  private spawnInterval: number = 0.05; // Spawn 20 veces/segundo
  private particlesPerSpawn: number = 5;

  // ── Parámetros de partícula (leídos del prefab) ────────────────────────────────
  private worldSpace: boolean = false;
  private spawnExtents: number[] = [2, 2, 2];
  private startSize: number = 0.1;
  private endSize: number = 0.1;
  private startColor: number[] = [1, 1, 1, 1];
  private endColor: number[] = [1, 1, 1, 1];
  private baseVelocity: number[] = [0, 1, 0];
  private gravity: number[] = [0, -9.81, 0];
  private particleLife: number = 3.0;
  private particleLifeVarMin: number = 0.0;
  private particleLifeVarMax: number = 0.0;
  private velocitySpread: number = 0.5;

  // ── Reuse buffers CPU para evitar allocations ────────────────────────────────
  private simParamsArray = new Float32Array(8); // 32 bytes: deltaTime + padding*3 + gravity(vec3) + padding
  private spawnParamsArray = new ArrayBuffer(96); // 96 bytes: ver SpawnParams en shader
  private spawnParamsFloat32View!: Float32Array;
  private spawnParamsUint32View!: Uint32Array;
  private counterDataArray = new Uint32Array(1);
  private particleRenderParamsArray = new Float32Array(12); // 48 bytes: startSize,endSize,pad,pad + startColor + endColor

  constructor() {
    super();
    // Inicializar views reutilizables
    this.spawnParamsFloat32View = new Float32Array(this.spawnParamsArray);
    this.spawnParamsUint32View = new Uint32Array(this.spawnParamsArray);
  }

  /** Escribe los parámetros de renderizado (tamaño/color) al buffer GPU */
  private writeRenderParamsBuffer(device: GPUDevice): void {
    const a = this.particleRenderParamsArray;
    a[0] = this.startSize;
    a[1] = this.endSize;
    a[2] = 0; // padding
    a[3] = 0; // padding
    a[4] = this.startColor[0];
    a[5] = this.startColor[1];
    a[6] = this.startColor[2];
    a[7] = this.startColor[3];
    a[8] = this.endColor[0];
    a[9] = this.endColor[1];
    a[10] = this.endColor[2];
    a[11] = this.endColor[3];
    device.queue.writeBuffer(this.particleRenderParamsBuffer, 0, a);
  }

  /** Escribe la gravedad (y el padding) al buffer de simulación */
  private writeGravityToSimBuffer(device: GPUDevice): void {
    // gravity va en offset 16 → indices 4,5,6 del Float32Array de 8 floats
    this.simParamsArray[4] = this.gravity[0];
    this.simParamsArray[5] = this.gravity[1];
    this.simParamsArray[6] = this.gravity[2];
    this.simParamsArray[7] = 0;
    // Escribir los 8 floats completos (32 bytes)
    device.queue.writeBuffer(this.simulationParamsBuffer, 0, this.simParamsArray);
  }

  public override async load(_data: unknown): Promise<void> {
    try {
      // Leer configuración
      const data = _data as ParticleSystemComponentData;
      this.worldSpace = data?.worldSpace ?? false;
      const rawRadius = data?.spawnRadius;
      if (Array.isArray(rawRadius)) {
        this.spawnExtents = rawRadius;
      } else if (typeof rawRadius === 'number') {
        this.spawnExtents = [rawRadius, rawRadius, rawRadius];
      } else {
        this.spawnExtents = [2, 2, 2];
      }
      this.maxParticles = data?.maxParticles ?? 1024;

      // emissionRate → spawnInterval + particlesPerSpawn
      // Si emissionRate <= 20: 1 partícula cada (1/emissionRate) segundos
      // Si emissionRate >  20: múltiples partículas cada 0.05s (20 ticks/s)
      const emissionRate = data?.emissionRate ?? 100;
      const MAX_TICK_RATE = 20; // ticks/segundo máximo
      if (emissionRate <= MAX_TICK_RATE) {
        this.spawnInterval = 1 / emissionRate;
        this.particlesPerSpawn = 1;
      } else {
        this.spawnInterval = 1 / MAX_TICK_RATE; // 0.05s
        this.particlesPerSpawn = Math.round(emissionRate / MAX_TICK_RATE);
      }

      // Parámetros visuales
      this.startSize = data?.startSize ?? 0.1;
      this.endSize = data?.endSize ?? 0.1;
      this.startColor = data?.startColor ?? [1, 1, 1, 1];
      this.endColor = data?.endColor ?? [1, 1, 1, 1];

      // Parámetros de movimiento
      this.baseVelocity = data?.baseVelocity ?? [0, 1, 0];
      this.gravity = data?.gravity ?? [0, -9.81, 0];
      this.velocitySpread = data?.velocitySpread ?? 0.5;

      // Vida de partícula
      this.particleLife = data?.particleLife ?? 3.0;
      this.particleLifeVarMin = data?.particleLifeVarianceMin ?? 0.0;
      this.particleLifeVarMax = data?.particleLifeVarianceMax ?? 0.0;

      // 1. Cargar mesh y material con la técnica apropiada según worldSpace
      const meshPath = data?.mesh ?? 'quad.obj';
      const materialPath =
        data?.material ?? (this.worldSpace ? 'particle_worldspace.mat' : 'particle.mat');
      this.quadMesh = await Mesh.get(meshPath);
      this.particleMaterial = await Material.get(materialPath);

      const device = GPUUtils.getDevice();

      this.transform = this.getOwner().getComponent('transform') as TransformComponent;

      // 2. Crear storage buffer para datos de partículas
      // Estructura: position(vec3 + padding) + velocity(vec3) + lifetime(f32) + age(f32) + active(u32) + padding(u32 x2)
      // Total: 48 bytes por partícula
      const PARTICLE_SIZE_FLOATS = 12; // 48 bytes / 4 bytes por float
      const particleData = new Float32Array(this.maxParticles * PARTICLE_SIZE_FLOATS);

      // Inicializar TODAS las partículas como muertas (alive = 0)
      const uint32View = new Uint32Array(particleData.buffer);
      for (let i = 0; i < this.maxParticles; i++) {
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
      // instanceCount es FIJO = maxParticles; el VS descarta partículas muertas.
      const indirectArgs = new Uint32Array([
        6, // indexCount (quad)
        this.maxParticles, // instanceCount FIJO - skip dead en VS
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

      // 4. Dead Particle Free List: inicialmente todos los índices están libres
      const freeListData = new Uint32Array(this.maxParticles);
      for (let i = 0; i < this.maxParticles; i++) {
        freeListData[i] = i; // Índice de la partícula
      }

      this.freeListBuffer = device.createBuffer({
        label: 'particle_free_list',
        size: freeListData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.freeListBuffer, 0, freeListData);

      // Contador de slots libres (inicialmente = maxParticles)
      const freeListCount = new Uint32Array([this.maxParticles]);
      this.freeListCountBuffer = device.createBuffer({
        label: 'particle_free_list_count',
        size: 4, // 1 × u32 = 4 bytes
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.freeListCountBuffer, 0, freeListCount);

      // 5. Crear ParticleRenderParams buffer (48 bytes: startSize, endSize, pad, pad, startColor, endColor)
      this.particleRenderParamsBuffer = device.createBuffer({
        label: 'particle_render_params_buffer',
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // 6. Crear bind group para el storage buffer (group 3)
      //    binding 0: particle storage array (read by VS)
      //    binding 1: ParticleRenderParams uniform (read by VS)
      const renderBindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
          },
        ],
      });

      this.renderBindGroup = device.createBindGroup({
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffer } },
          { binding: 1, resource: { buffer: this.particleRenderParamsBuffer } },
        ],
      });

      // Escribir render params iniciales (particleRenderParamsBuffer ya existe)
      this.writeRenderParamsBuffer(device);

      // 7. Crear compute shader pipeline y recursos
      await this.createComputePipeline();

      // Escribir gravedad inicial al buffer de simulación (creado en createComputePipeline)
      this.writeGravityToSimBuffer(device);

      // 8. Registrar la key instanciada en el RenderManagerV2
      this.renderComponent = new RenderComponent();
      this.renderComponent.setOwner(this.getOwner());
      RenderManagerV2.getInstance().addKey(
        this.renderComponent,
        this.quadMesh,
        this.particleMaterial,
        this.transform,
        true, // Skip CPU frustum culling
        this.maxParticles,
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
      size: 96, // SpawnParams struct: ver comentario de layout en particle_spawn_compact.cs
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
    const updateShaderCode = await ResourceManager.loadShader('particles/particle_update.cs');
    const spawnCompactShaderCode = await ResourceManager.loadShader(
      'particles/particle_spawn_compact.cs',
    );

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

    // 2. Actualizar deltaTime en el buffer de simulación (gravity se escribe una sola vez en load)
    this.simParamsArray[0] = deltaTime;
    device.queue.writeBuffer(this.simulationParamsBuffer, 0, this.simParamsArray, 0, 1);

    // Verificar si es momento de spawn
    const shouldSpawn = this.spawnTimer >= this.spawnInterval;

    if (shouldSpawn) {
      this.spawnTimer = 0;

      // Preparar parámetros de spawn según SpawnParams en particle_spawn_compact.cs (80 bytes)
      this.spawnParamsUint32View[0] = this.particlesPerSpawn; // [0]  spawnCount
      this.spawnParamsFloat32View[1] = Math.random() * 10000.0; // [1]  randomSeed
      this.spawnParamsUint32View[2] = this.worldSpace ? 1 : 0; // [2]  worldSpace
      this.spawnParamsFloat32View[3] = 0; // [3]  padding1

      const worldPos = this.transform.getTransform().getWorldPosition();
      this.spawnParamsFloat32View[4] = worldPos[0]; // [4]  emitterWorldPos.x
      this.spawnParamsFloat32View[5] = worldPos[1]; // [5]  emitterWorldPos.y
      this.spawnParamsFloat32View[6] = worldPos[2]; // [6]  emitterWorldPos.z
      this.spawnParamsFloat32View[7] = 0; // [7]  padding2

      const worldScale = this.transform.getTransform().getWorldScale();
      this.spawnParamsFloat32View[8] = worldScale[0]; // [8]  emitterWorldScale.x
      this.spawnParamsFloat32View[9] = worldScale[1]; // [9]  emitterWorldScale.y
      this.spawnParamsFloat32View[10] = worldScale[2]; // [10] emitterWorldScale.z
      this.spawnParamsFloat32View[11] = 0; // [11] padding3

      // spawnExtents (vec3) at offset 48 → float index 12,13,14 (16-byte aligned)
      this.spawnParamsFloat32View[12] = this.spawnExtents[0]; // [12] spawnExtents.x
      this.spawnParamsFloat32View[13] = this.spawnExtents[1]; // [13] spawnExtents.y
      this.spawnParamsFloat32View[14] = this.spawnExtents[2]; // [14] spawnExtents.z
      this.spawnParamsFloat32View[15] = this.velocitySpread; // [15] velocitySpread (offset 60)

      // baseVelocity (vec3) at offset 64 → float index 16,17,18 (auto-aligned to 16 ✓)
      this.spawnParamsFloat32View[16] = this.baseVelocity[0]; // [16] baseVelocity.x
      this.spawnParamsFloat32View[17] = this.baseVelocity[1]; // [17] baseVelocity.y
      this.spawnParamsFloat32View[18] = this.baseVelocity[2]; // [18] baseVelocity.z
      this.spawnParamsFloat32View[19] = this.particleLife; // [19] particleLife (offset 76)
      this.spawnParamsFloat32View[20] = this.particleLifeVarMin; // [20] particleLifeVarMin (offset 80)
      this.spawnParamsFloat32View[21] = this.particleLifeVarMax; // [21] particleLifeVarMax (offset 84)

      device.queue.writeBuffer(this.spawnParamsBuffer, 0, this.spawnParamsArray);

      // OPTIMIZACIÓN: Resetear contador atómico reutilizando buffer CPU
      // ANTES: new Uint32Array([...]) cada spawn → GC pressure
      // AHORA: reutilizar counterDataArray → 0 allocations
      this.counterDataArray[0] = this.particlesPerSpawn;
      device.queue.writeBuffer(this.spawnCounterBuffer, 0, this.counterDataArray);

      // Actualizar render params si cambiaron (p.ej. debug UI)
      this.writeRenderParamsBuffer(device);
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
    const updateWorkgroups = Math.ceil(this.maxParticles / 64);
    updatePass.dispatchWorkgroups(updateWorkgroups);
    updatePass.end();

    // Pass 2: SPAWN (solo si toca) - crea nuevas partículas
    if (shouldSpawn) {
      const spawnPass = encoder.beginComputePass({ label: 'Spawn Pass' });
      spawnPass.setPipeline(this.spawnPipeline);
      spawnPass.setBindGroup(0, this.spawnCompactBindGroup);
      const spawnWorkgroups = Math.ceil(this.maxParticles / 64);
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
    const stats = { maxParticles: this.maxParticles };
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
    this.particleRenderParamsBuffer?.destroy();
  }
}
