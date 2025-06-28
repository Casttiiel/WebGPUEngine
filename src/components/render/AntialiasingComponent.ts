import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';

export class AntialiasingComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderToTexture;
  private renderPassManager!: RenderPassManager;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('antialiasing.tech');

    this.result = new RenderToTexture();
    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, 'rgba16float');
  }

  public resize(): void {
    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, 'rgba16float');
    this.bindGroup = null;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    this.setBindGroup(texture);

    // Use RenderPassManager to execute antialiasing pass dynamically
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.technique,
      this.bindGroup!,
      this.result
    );

    return this.result.getView();
  }

  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = BindGroupFactory.createBindGroup(
      `antialiasing_bindgroup`,
      this.technique.getPipeline().getBindGroupLayout(1),
      [
        {
          binding: 0,
          resource: texture,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ]
    );
  }

  public update(_dt: number): void {
    throw new Error('Method not implemented.');
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
