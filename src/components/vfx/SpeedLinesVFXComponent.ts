import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Texture } from '../../renderer/resources/Texture';
import { CharacterControllerComponent } from '../game/CharacterControllerComponent';
import { Engine } from '../../core/engine/Engine';

export class SpeedLinesVFXComponent extends Component {
  private isLoaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private noiseTexture!: Texture;
  private renderPassManager!: RenderPassManager;

  private uniformBuffer!: GPUBuffer;
  private bufferBindGroup!: GPUBindGroup;

  private time = 0;

  // ✅ Cache bind groups per texture to avoid recreation every frame
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('speed_lines.tech');
    this.noiseTexture = await Texture.getAsync('noiseRGB.jpg');

    this.uniformBuffer = Render.getInstance()
      .getDevice()
      .createBuffer({
        label: 'speed_lines_uniform_buffer',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    // Initialize with default values
    Render.getInstance()
      .getDevice()
      .queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([0, 0, 0, 0]));

    this.bufferBindGroup = BindGroupFactory.createBindGroup(
      `speed_lines_uniform_bindgroup`,
      this.technique.getPipeline().getBindGroupLayout(1),
      [
        {
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
          },
        },
      ],
    );

    this.isLoaded = true;
  }

  public resize(): void {}

  public apply(texture: GPUTextureView): void {
    const textureBindGroup = this.getOrCreateBindGroup();

    // Use RenderPassManager to execute tone mapping pass dynamically
    this.renderPassManager.executeSpeedLinesVFXPass(
      this.fullscreenQuadMesh,
      this.technique,
      textureBindGroup,
      this.bufferBindGroup,
      texture,
    );
  }

  /**
   * ✅ Get or create cached bind group for texture (avoids recreation every frame)
   */
  private getOrCreateBindGroup(): GPUBindGroup {
    let bindGroup = this.bindGroupCache.get(this.noiseTexture.getTextureView()!);
    if (!bindGroup) {
      const sampler = SamplerLibrary.anisotropic16x;
      bindGroup = BindGroupFactory.createBindGroup(
        `speed_lines_vfx_bindgroup`,
        this.technique.getPipeline().getBindGroupLayout(0),
        [
          {
            binding: 0,
            resource: this.noiseTexture.getTextureView()!,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      );
      this.bindGroupCache.set(this.noiseTexture.getTextureView()!, bindGroup);
    }
    return bindGroup;
  }
  public update(dt: number): void {
    const characterController = Engine.getEntities()
      .getEntityByName('Player')
      ?.getComponent('character_controller');
    if (!characterController) return;
    const speed =
      ((characterController as CharacterControllerComponent).getCurrentSpeed() ?? 0.0) / 30.0; //TODO THIS NUMBER CHANGE
    this.time += dt;
    Render.getInstance()
      .getDevice()
      .queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([speed, 0, 0, this.time]));
  }

  public override renderInMenu(): void {}

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public hasLoaded(): boolean {
    return this.isLoaded;
  }
}
