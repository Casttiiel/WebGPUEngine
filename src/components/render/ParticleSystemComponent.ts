import { Component } from '../../core/ecs/Component';
import { Material } from '../../renderer/resources/Material';
import { Mesh } from '../../renderer/resources/Mesh';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TransformComponent } from '../core/TransformComponent';
import { RenderComponent } from './RenderComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

/**
 * ParticleSystemComponent - Manages a basic instanced quad particle system
 * that renders 4 instances of a quad through the RenderManager
 */
export class ParticleSystemComponent extends Component {
  private quadMesh!: Mesh;
  private particleMaterial!: Material;
  private transform!: TransformComponent;
  private static readonly INSTANCE_COUNT: number = 4;

  // Instance data
  private instancePositions: Float32Array;
  private instanceBuffer!: GPUBuffer;
  private renderComponent!: RenderComponent;

  constructor() {
    super();
    // Initialize instance positions in a 2x2 grid más cerca y más pequeño
    this.instancePositions = new Float32Array([
      -2,
      0,
      -2, // Instance 1: bottom-left
      2,
      0,
      -2, // Instance 2: bottom-right
      -2,
      0,
      2, // Instance 3: top-left
      2,
      0,
      2, // Instance 4: top-right
    ]);
  }

  /**
   * Creates and initializes the instance buffer with position data
   */
  private initializeInstanceBuffer(): void {
    // Create instance buffer
    this.instanceBuffer = GPUUtils.createBuffer(
      'particle_instance_buffer',
      this.instancePositions.byteLength,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      this.instancePositions,
    );
  }

  /**
   * Updates instance positions in the GPU buffer
   */
  private updateInstanceBuffer(): void {
    GPUUtils.writeBuffer(this.instanceBuffer, 0, this.instancePositions);
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

      // Get transform component from our entity
      this.transform = this.getOwner().getComponent('transform') as TransformComponent;
      if (!this.transform) {
        throw new Error('ParticleSystemComponent requires a TransformComponent');
      }

      // Initialize instance data
      this.initializeInstanceBuffer();

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
        this.instanceBuffer, // Pass the instance buffer
      );
    } catch (error: any) {
      throw error;
    }
  }

  public override update(deltaTime: number): void {
    // Update particle positions here (example: rotate around Y axis)
    const angle = deltaTime * 2.0; // Rotate 2 radians per second
    for (let i = 0; i < this.instancePositions.length; i += 3) {
      const x = this.instancePositions[i] || 0;
      const z = this.instancePositions[i + 2] || 0;

      // Apply rotation matrix
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.instancePositions[i] = x * cos - z * sin;
      this.instancePositions[i + 2] = x * sin + z * cos;
    }

    // Update GPU buffer with new positions
    this.updateInstanceBuffer();
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
    this.instanceBuffer?.destroy();
  }
}
