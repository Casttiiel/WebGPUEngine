import { Component } from '../../core/ecs/Component';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

export class ToneMappingComponent extends Component {
  private isLoaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // ✅ Cache bind groups per texture to avoid recreation every frame
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/tone_mapping.tech');

    const toneMappingFormat = QualitySettings.getInstance().getSettings().toneMappingTexture;

    this.result = new RenderTarget();
    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);

    this.isLoaded = true;
  }

  public resize(): void {
    const toneMappingFormat = QualitySettings.getInstance().getSettings().toneMappingTexture;

    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);
    // ✅ Clear cache on resize (textures recreated)
    this.bindGroupCache.clear();
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    const bindGroup = this.getOrCreateBindGroup(texture);

    // Use RenderPassManager to execute tone mapping pass dynamically
    this.renderPassManager.executeToneMappingPass(
      this.fullscreenQuadMesh,
      this.technique,
      bindGroup,
      this.result,
    );

    return this.result.getView();
  }

  /**
   * ✅ Get or create cached bind group for texture (avoids recreation every frame)
   */
  private getOrCreateBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.bindGroupCache.get(texture);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

      bindGroup = BindGroupFactory.createBindGroup(
        `tonemapping_bindgroup`,
        this.technique.getPipeline().getBindGroupLayout(0),
        [
          {
            binding: 0,
            resource: texture,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      );
      this.bindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }
  public update(_dt: number): void {
    throw new Error('Method not implemented.');
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
