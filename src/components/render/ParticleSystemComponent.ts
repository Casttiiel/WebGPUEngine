import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

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

      // 2. Crear storage buffer para datos de partículas (posición, etc.)
      // IMPORTANTE: vec3 en storage buffer necesita alineamiento de 16 bytes (vec4)
      const particleData = new Float32Array([
        -2,
        0,
        2,
        0, // Partícula 0 (x, y, z, padding)
        2,
        0,
        2,
        0, // Partícula 1 (x, y, z, padding)
        2,
        0,
        -2,
        0, // Partícula 2 (x, y, z, padding)
        -2,
        0,
        -2,
        0, // Partícula 3 (x, y, z, padding)
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

      // 5. Registrar la key instanciada en el RenderManagerV2
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

  public override update(deltaTime: number): void {}

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
