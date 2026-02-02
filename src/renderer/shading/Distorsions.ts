import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderTarget } from '../resources/RenderTarget';
import { QualitySettings } from '../../core/engine/QualitySettings';

export class Distorsions {
  private distorsionsBuffer!: RenderTarget;
  private distorsionsBindGroup!: GPUBindGroup;
  private distorsionsCombineBindGroup!: GPUBindGroup;

  private fullscreenQuadMesh!: Mesh;
  private distorsionsCombineTechnique!: Technique;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.distorsionsCombineTechnique = await Technique.getAsync(
      'post-processing/distorsions_combine.tech',
    );
    this.distorsionsBuffer = new RenderTarget();
    this.distorsionsBuffer.createRT(
      'distorsions_buffer',
      Render.width,
      Render.height,
      QualitySettings.getInstance().getSettings().hdrTexture,
    );
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    this.renderDistorsionsBuffer(rtAccLight, depthStencilView);
    this.renderDistorsionsResult(rtAccLight);
  }

  private renderDistorsionsBuffer(
    rtAccLight: GPUTextureView,
    depthStencilView: GPUTextureView,
  ): void {
    const render = Render.getInstance();

    if (!this.distorsionsBindGroup) {
      this.createDistorsionsBindGroup(rtAccLight);
    }

    const colorAttachment = GPUUtils.createColorAttachment(
      this.distorsionsBuffer.getView(),
      'clear',
      'store',
      {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
      },
    );
    const depthAttachment = GPUUtils.createDepthStencilAttachment(
      depthStencilView,
      'load',
      'discard',
    );
    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          'Distorsions Render pass',
          [colorAttachment],
          depthAttachment,
        ),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

    pass.setBindGroup(3, this.distorsionsBindGroup);

    RenderManager.getInstance().render(RenderCategory.DISTORSIONS, pass);

    pass.end();
  }

  private renderDistorsionsResult(rtAccLight: GPUTextureView): void {
    if (!this.distorsionsCombineBindGroup) {
      this.createDistorsionsCombineBindGroup();
    }
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('distorions combine render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.distorsionsCombineTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    pass.setBindGroup(0, this.distorsionsCombineBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createDistorsionsBindGroup(rtAccLight: GPUTextureView): void {
    this.distorsionsBindGroup = BindGroupFactory.createBindGroup(
      'distorsions_buffer_bindgroup',
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: rtAccLight,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
      ],
    );
  }

  private createDistorsionsCombineBindGroup(): void {
    this.distorsionsCombineBindGroup = BindGroupFactory.createBindGroup(
      'distorsions_combine_bindgroup',
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.distorsionsBuffer.getView(),
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
      ],
    );
  }

  public resize(): void {
    this.destroy();
  }

  public update(_dt: number): void {}

  public destroy(): void {
    if (this.distorsionsBuffer) {
      this.distorsionsBuffer.createRT(
        'distorsions_buffer',
        Render.width,
        Render.height,
        QualitySettings.getInstance().getSettings().hdrTexture,
      );
    }

    this.distorsionsBindGroup = null!;
    this.distorsionsCombineBindGroup = null!;
  }
}
