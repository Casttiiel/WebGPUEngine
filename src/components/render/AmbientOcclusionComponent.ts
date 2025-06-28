import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';

export class AmbientOcclusionComponent extends Component {
  private aoTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets for the two-pass process
  private rawAOTarget!: RenderToTexture;
  private bilateralFilterBindGroup!: GPUBindGroup | null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.aoTechnique = await Technique.get('ambient_occlusion.tech');
    this.bilateralFilterTechnique = await Technique.get('ao_bilateral_filter.tech');

    // Create intermediate render target for raw AO
    this.rawAOTarget = new RenderToTexture();
    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, 'r16float');
  }

  public resize(): void {
    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, 'r16float');
    this.bilateralFilterBindGroup = null;
  }

  public compute(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderToTexture): void {
    // Pass 1: Generate raw AO using SSAO
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.aoTechnique,
      gBufferBindGroup,
      this.rawAOTarget
    );

    // Pass 2: Apply bilateral filter to the raw AO
    this.applyBilateralFilter(gBufferBindGroup, finalAOTarget);
  }

  private applyBilateralFilter(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderToTexture): void {
    this.setupBilateralFilterBindGroup();

    // Use RenderPassManager to execute bilateral filter pass with both bind groups
    this.renderPassManager.executeAOBilateralFilterPass(
      this.fullscreenQuadMesh,
      this.bilateralFilterTechnique,
      gBufferBindGroup,              // G-Buffer bind group (group 1)
      this.bilateralFilterBindGroup!, // AO texture bind group (group 2)
      finalAOTarget
    );
  }

  private setupBilateralFilterBindGroup(): void {
    if (this.bilateralFilterBindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create bind group for AO texture (group 2 in the shader) using SingleTexture layout
    this.bilateralFilterBindGroup = BindGroupFactory.createBindGroup(
      `ao_bilateral_filter_bindgroup`,
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.rawAOTarget.getView(),
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
