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

      // 2. Crear storage buffer para datos de partículas (posición + velocidad)
      // IMPORTANTE: vec3 en storage buffer necesita alineamiento de 16 bytes (vec4)
      const particleData = new Float32Array([
        // Partícula 0: pos(-2, 0, 2) + vel(1, 0, 0) = moviéndose hacia la derecha
        -2,
        1,
        2,
        0, // position + padding
        1,
        0,
        0,
        0, // velocity + padding

        // Partícula 1: pos(2, 0, 2) + vel(0, 0, -1) = moviéndose hacia atrás
        2,
        0,
        2,
        0, // position + padding
        0,
        0,
        -1,
        0, // velocity + padding

        // Partícula 2: pos(2, 0, -2) + vel(-1, 0, 0) = moviéndose hacia la izquierda
        2,
        0,
        -2,
        0, // position + padding
        -1,
        0,
        0,
        0, // velocity + padding

        // Partícula 3: pos(-2, 0, -2) + vel(0, 0, 1) = moviéndose hacia adelante
        -2,
        0,
        -2,
        0, // position + padding
        0,
        0,
        1,
        0, // velocity + padding
      ]);
      this.particleBuffer = device.createBuffer({
        label: 'particle_storage_buffer',
        size: particleData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.particleBuffer, 0, particleData);

      // 3. Crear buffer indirecto (indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
      const indirectArgs = new Uint32Array([
        6, // indexCount (quad)
        ParticleSystemComponent.MAX_PARTICLES, // instanceCount
        0, // firstIndex
        0, // baseVertex
        0, // firstInstance
      ]);
      this.indirectDrawBuffer = device.createBuffer({
        label: 'particle_indirect_buffer',
        size: indirectArgs.byteLength,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
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
  }
}
