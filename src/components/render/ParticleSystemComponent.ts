import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';

/**
 * ParticleSystemComponent - GPU-driven particle system using indirect draw
 * for efficient rendering of dynamic particle counts
 */
export class ParticleSystemComponent extends Component {
  private static readonly MAX_PARTICLES = 4; // ejemplo sencillo
  private quadMesh!: Mesh;
  private particleMaterial!: Material;
  private transform!: TransformComponent;
  private particleBuffer!: GPUBuffer;
  private indirectDrawBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderComponent!: RenderComponent;

  // Compute shader resources
  private computePipeline!: GPUComputePipeline;
  private computeBindGroup!: GPUBindGroup;
  private simulationParamsBuffer!: GPUBuffer;

  constructor() {
    super();
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

      // Inicializar primeras 4 partículas como vivas con diferentes configuraciones
      const particles = [
        { pos: [-1, 0, 2], vel: [0, 0, 0], lifetime: 10.0 }, // Partícula 0
        { pos: [1, 1, 2], vel: [0, 0, 0], lifetime: 5.0 }, // Partícula 1
        { pos: [1, 0, -2], vel: [0, 0, 0], lifetime: 10.0 }, // Partícula 2
        { pos: [-1, 0, -2], vel: [0, 0, 0], lifetime: 10.0 }, // Partícula 3
      ];

      for (let i = 0; i < particles.length; i++) {
        const offset = i * PARTICLE_SIZE_FLOATS;
        const p = particles[i]!; // Non-null assertion ya que sabemos que existe

        particleData[offset + 0] = p.pos[0]!; // position.x
        particleData[offset + 1] = p.pos[1]!; // position.y
        particleData[offset + 2] = p.pos[2]!; // position.z
        particleData[offset + 3] = 0; // padding1

        particleData[offset + 4] = p.vel[0]!; // velocity.x
        particleData[offset + 5] = p.vel[1]!; // velocity.y
        particleData[offset + 6] = p.vel[2]!; // velocity.z
        particleData[offset + 7] = p.lifetime; // lifetime

        particleData[offset + 8] = 0.0; // age (empieza en 0)

        // active y padding como uint32, pero los escribimos en el Float32Array
        const uint32View = new Uint32Array(particleData.buffer);
        const uint32Offset = offset + 9;
        uint32View[uint32Offset + 0] = 1; // active = 1 (viva)
        uint32View[uint32Offset + 1] = 0; // padding2
        uint32View[uint32Offset + 2] = 0; // padding3
      }

      // El resto de partículas quedan con active = 0 (muertas) por defecto

      this.particleBuffer = device.createBuffer({
        label: 'particle_storage_buffer',
        size: particleData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.particleBuffer, 0, particleData);

      // 3. Crear buffer indirecto (indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
      const indirectArgs = new Uint32Array([
        6, // indexCount (quad)
        4, // instanceCount (empezamos con 4 partículas vivas)
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

    // 1. Crear buffer para parámetros de simulación
    this.simulationParamsBuffer = device.createBuffer({
      label: 'simulation_params_buffer',
      size: 32, // Mínimo 32 bytes para uniform buffer en WebGPU
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 2. Cargar el shader del compute

    const shaderCode = await ResourceManager.loadShader('particle_update.cs');
    const computeShader = device.createShaderModule({
      label: 'particle_update_cs',
      code: shaderCode,
    });

    // 3. Crear compute pipeline
    this.computePipeline = device.createComputePipeline({
      label: 'particle_update_pipeline',
      layout: 'auto',
      compute: {
        module: computeShader,
        entryPoint: 'main',
      },
    });

    // 4. Crear bind group para el compute shader
    this.computeBindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.particleBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.simulationParamsBuffer },
        },
        {
          binding: 2,
          resource: { buffer: this.indirectDrawBuffer },
        },
      ],
    });
  }

  public override update(deltaTime: number): void {
    // Actualizar parámetros de simulación (32 bytes = 8 floats)
    const simParams = new Float32Array([deltaTime, 0, 0, 0, 0, 0, 0, 0]); // deltaTime + padding para 32 bytes
    const device = GPUUtils.getDevice();
    device.queue.writeBuffer(this.simulationParamsBuffer, 0, simParams);

    // Ejecutar compute shader
    const commandEncoder = device.createCommandEncoder({ label: 'Particle Update' });
    const computePass = commandEncoder.beginComputePass({ label: 'Particle Update Pass' });

    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    // Dispatch workgroups (64 partículas por workgroup)
    const numWorkgroups = Math.ceil(ParticleSystemComponent.MAX_PARTICLES / 64);
    computePass.dispatchWorkgroups(numWorkgroups);

    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Spawn una nueva partícula en el primer slot muerto disponible
   * @param position Posición inicial de la partícula
   * @param velocity Velocidad inicial de la partícula
   * @param lifetime Tiempo de vida en segundos
   * @returns true si se pudo spawn, false si no hay slots disponibles
   */
  public spawnParticle(
    position: [number, number, number],
    velocity: [number, number, number],
    lifetime: number,
  ): boolean {
    const device = GPUUtils.getDevice();
    const PARTICLE_SIZE_FLOATS = 12; // 48 bytes / 4 bytes por float

    // Crear buffer temporal para leer datos actuales de partículas
    const readBuffer = device.createBuffer({
      label: 'particle_read_buffer',
      size: this.particleBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Copiar datos del particle buffer al read buffer
    const commandEncoder = device.createCommandEncoder({ label: 'Copy Particle Data' });
    commandEncoder.copyBufferToBuffer(
      this.particleBuffer,
      0,
      readBuffer,
      0,
      this.particleBuffer.size,
    );
    device.queue.submit([commandEncoder.finish()]);

    // Mapear el buffer para lectura (asíncrono)
    readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const particleData = new Float32Array(readBuffer.getMappedRange());
      const uint32View = new Uint32Array(particleData.buffer);

      // Buscar primer slot muerto (active = 0)
      let slotIndex = -1;
      for (let i = 0; i < ParticleSystemComponent.MAX_PARTICLES; i++) {
        const offset = i * PARTICLE_SIZE_FLOATS;
        const uint32Offset = offset + 9;
        const active = uint32View[uint32Offset];

        if (active === 0) {
          slotIndex = i;
          break;
        }
      }

      readBuffer.unmap();
      readBuffer.destroy();

      if (slotIndex === -1) {
        console.warn('No hay slots disponibles para spawn de partícula');
        return false;
      }

      // Escribir nueva partícula en el slot encontrado
      const offset = slotIndex * PARTICLE_SIZE_FLOATS;
      const newParticleData = new Float32Array(PARTICLE_SIZE_FLOATS);

      newParticleData[0] = position[0]; // position.x
      newParticleData[1] = position[1]; // position.y
      newParticleData[2] = position[2]; // position.z
      newParticleData[3] = 0; // padding1

      newParticleData[4] = velocity[0]; // velocity.x
      newParticleData[5] = velocity[1]; // velocity.y
      newParticleData[6] = velocity[2]; // velocity.z
      newParticleData[7] = lifetime; // lifetime

      newParticleData[8] = 0.0; // age (empieza en 0)

      const newUint32View = new Uint32Array(newParticleData.buffer);
      newUint32View[9] = 1; // active = 1 (viva)
      newUint32View[10] = 0; // padding2
      newUint32View[11] = 0; // padding3

      // Escribir al buffer GPU
      device.queue.writeBuffer(this.particleBuffer, offset * 4, newParticleData);

      console.log(`Partícula spawneada en slot ${slotIndex}`);
      return true;
    });

    return true; // Retornar true inmediatamente (el spawn es asíncrono)
  }

  public override renderInMenu(): void {
    // TODO: Add debug controls for particle positions and animation speed
  }

  public override renderDebug(): void {
    // TODO: Add visualization of particle positions and movement paths
  }

  public dispose(): void {
    // Cleanup GPU resources
    this.particleBuffer?.destroy();
    this.indirectDrawBuffer?.destroy();
    this.simulationParamsBuffer?.destroy();
  }
}
