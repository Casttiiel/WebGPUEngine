import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ResourceManager } from '../../core/engine/ResourceManager';

/**
 * ParticleSystemComponent - Manages a basic instanced quad particle system
 * that renders 4 instances of a quad through the RenderManager
 */
export class ParticleSystemComponent extends Component {
  private quadMesh!: Mesh;
  private particleMaterial!: Material;
  private transform!: TransformComponent;
  private static readonly INSTANCE_COUNT: number = 4;

  // GPU Resources
  private particleBuffer!: GPUBuffer; // Storage buffer for particles
  private timeBuffer!: GPUBuffer; // Uniform buffer for deltaTime
  private computePipeline!: GPUComputePipeline;
  private computeBindGroup!: GPUBindGroup;
  private renderComponent!: RenderComponent;

  // Particle data structure (matches compute shader)
  private particleData: Float32Array;

  constructor() {
    super();
    // Initialize particles with just position
    // Format: [pos.x, pos.y, pos.z] per particle
    this.particleData = new Float32Array([
      // Particle 1: esquina frontal izquierda
      -1, 0, -1,

      // Particle 2: esquina frontal derecha
      1, 1, -1,

      // Particle 3: esquina trasera derecha
      2, 1, 1,

      // Particle 4: esquina trasera izquierda
      -1, 1, 1,
    ]);
  }

  private async createComputePipeline(): Promise<void> {
    const device = GPUUtils.getDevice();

    // Load compute shader
    const computeShaderCode = await ResourceManager.loadShader('particle_update.cs');
    const computeShaderModule = device.createShaderModule({
      label: 'particle_update_cs',
      code: computeShaderCode,
    });

    // Create bind group layout
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'particle_bind_group_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      label: 'particle_pipeline_layout',
      bindGroupLayouts: [bindGroupLayout],
    });

    // Create compute pipeline
    this.computePipeline = device.createComputePipeline({
      label: 'particle_compute_pipeline',
      layout: pipelineLayout,
      compute: {
        module: computeShaderModule,
        entryPoint: 'cs',
      },
    });

    // Create storage buffer for particles
    this.particleBuffer = device.createBuffer({
      label: 'particle_storage_buffer',
      size: this.particleData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });

    // Write initial data
    new Float32Array(this.particleBuffer.getMappedRange()).set(this.particleData);
    this.particleBuffer.unmap();

    // Create uniform buffer for time
    this.timeBuffer = GPUUtils.createBuffer(
      'particle_time_buffer',
      4, // Just deltaTime as float32
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create bind group
    this.computeBindGroup = device.createBindGroup({
      label: 'particle_compute_bind_group',
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.particleBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.timeBuffer },
        },
      ],
    });
  }

  /**
   * Updates particle positions using compute shader
   */
  private updateParticles(deltaTime: number): void {
    // Update time uniform
    GPUUtils.writeBuffer(this.timeBuffer, 0, new Float32Array([deltaTime]));

    // Begin compute pass
    const device = GPUUtils.getDevice();
    const commandEncoder = device.createCommandEncoder({ label: 'Particle Update Encoder' });
    const computePass = commandEncoder.beginComputePass({ label: 'Particle Update Pass' });

    // Set pipeline and bind group
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    // Dispatch exactly one workgroup for our 4 particles
    computePass.dispatchWorkgroups(1, 1, 1);

    // End pass and submit commands
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Creates a material for the particles
   */
  private async createParticleMaterial(): Promise<Material> {
    return await Material.get('particle.mat');
  }

  public override async load(_data: unknown): Promise<void> {
    try {
      // Create mesh and material
      this.quadMesh = await Mesh.get('quad.obj'); // Usar un quad normal en lugar de fullscreen
      this.particleMaterial = await this.createParticleMaterial();

      // Create compute pipeline and GPU resources
      await this.createComputePipeline();

      // Get transform component from our entity
      this.transform = this.getOwner().getComponent('transform') as TransformComponent;
      if (!this.transform) {
        throw new Error('ParticleSystemComponent requires a TransformComponent');
      }

      // Register with RenderManager as instanced renderer
      const renderManager = RenderManagerV2.getInstance();

      // Create render component for the instanced rendering
      this.renderComponent = new RenderComponent();
      this.renderComponent.setOwner(this.getOwner());

      // Register with render manager using instancing configuration
      renderManager.addKey(
        this.renderComponent,
        this.quadMesh,
        this.particleMaterial,
        this.transform,
        true, // isInstanced
        ParticleSystemComponent.INSTANCE_COUNT,
        this.particleBuffer, // Pass the storage buffer as instance buffer
      );
    } catch (error: any) {
      throw error;
    }
  }

  public override update(deltaTime: number): void {
    // Update particle positions using compute shader
    this.updateParticles(deltaTime);
  }

  public override renderInMenu(): void {
    // TODO: Add debug controls for particle positions and animation speed
  }

  public override renderDebug(): void {
    // TODO: Add visualization of particle positions and movement paths
  }

  public dispose(): void {
    console.log('ParticleSystemComponent: Disposing resources');
    // Remove from render manager
    RenderManagerV2.getInstance().delKeys(this.renderComponent);

    // Cleanup GPU resources
    this.particleBuffer?.destroy();
    this.timeBuffer?.destroy();
  }
}
