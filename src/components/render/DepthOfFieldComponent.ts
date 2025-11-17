import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { DOFRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BlurComponent } from './BlurComponent';

export class DepthOfFieldComponent extends BlurComponent {
  private technique!: Technique;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  private paramsBuffer!: GPUBuffer; // Buffer específico para parámetros del combine
  private paramsBindGroup!: GPUBindGroup | null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public override async load(): Promise<void> {
    // Load parent blur component first
    await super.load();

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('dof.tech');

    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    this.result = new RenderTarget();
    this.result.createRT('dof_result.dds', Render.width, Render.height, hdrTexture);

    // Create uniform buffer specifically for bloom filter parameters
    this.paramsBuffer = GPUUtils.createBuffer(
      'dof_params_buffer',
      16, // 4 floats * 4 bytes
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateParams();
  }

  public override resize(): void {
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    this.result.createRT('dof_result.dds', Render.width, Render.height, hdrTexture);
    this.paramsBindGroup = null;
  }

  private updateParams(): void {
    // Update bloom filter parameters buffer
    const paramsData = new Float32Array([7.0, 2.0, 10.0, 2.0]);

    GPUUtils.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    const blurImage = this.applyBlur(inputTexture);

    this.addDOF(inputTexture, blurImage, gBufferBindGroup);

    return this.result.getRenderView()!;
  }

  public addDOF(
    originalTexture: GPUTextureView,
    blurTexture: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    this.setParamsBindGroup(originalTexture, blurTexture);

    // Use the RenderPassFactory to create a post-process pass config
    const passConfig = RenderPassFactory.createDOFPassConfig(this.result!.getRenderView()!);

    // Create a DOF render pass
    const pass = new DOFRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.technique,
      this.paramsBindGroup!,
      gBufferBindGroup!,
    );

    // Execute the custom pass directly using RenderPassManager
    this.renderPassManager.executeDynamicPass(pass);
  }

  private setParamsBindGroup(original: GPUTextureView, blur: GPUTextureView): void {
    if (this.paramsBindGroup) return;

    this.paramsBindGroup = BindGroupFactory.createBindGroup(
      `dof_bindgroup`,
      this.technique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: original,
        },
        {
          binding: 1,
          resource: blur,
        },
        {
          binding: 2,
          resource: {
            buffer: this.paramsBuffer,
          },
        },
      ],
    );
  }

  public hasLoaded(): boolean {
    return (
      this.technique !== undefined &&
      this.fullscreenQuadMesh !== undefined &&
      this.result !== undefined
    );
  }

  public override update(_dt: number): void {
    // Update depth of field parameters if needed
  }

  public debugInMenu(): void {
    // Implement debug menu for depth of field parameters
  }

  public override renderInMenu(): void {
    // Implement render menu for depth of field parameters
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }

  public override dispose(): void {
    super.dispose();

    if (this.result) {
      this.result.destroy();
    }
  }
}
