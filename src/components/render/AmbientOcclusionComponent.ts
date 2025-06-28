import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';

export class AmbientOcclusionComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }
  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('ambient_occlusion.tech');
  }

  public compute(gBufferBindGroup: GPUBindGroup, rtAO: RenderToTexture): void {
    // Use RenderPassManager to execute ambient occlusion pass dynamically
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      rtAO
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
