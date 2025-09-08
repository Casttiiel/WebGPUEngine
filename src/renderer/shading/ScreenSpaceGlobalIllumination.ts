import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { RenderPassManager } from '../core/passes/RenderPassManager';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Mesh } from '../resources/Mesh';
import { RenderTarget } from '../resources/RenderTarget';
import { Technique } from '../resources/Technique';

export class ScreenSpaceGlobalIllumination {
  private isInitialized: boolean = false;
  private fullscreenQuadMesh!: Mesh;
  private ssgiTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private ssgiResult!: RenderTarget;
  private finalSSGIResult!: RenderTarget;
  private bilateralFilterBindGroup!: GPUBindGroup | null;
  private renderPassManager!: RenderPassManager;

  constructor() {
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    try {
      this.isInitialized = true;
      this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
      this.ssgiTechnique = await Technique.getAsync('ssgi.tech');
      this.bilateralFilterTechnique = await Technique.getAsync('ssgi_bilateral_filter.tech');

      this.createRenderTarget();

      console.log('SSGI loaded successfully');
    } catch (error) {
      console.warn('Failed to load SSGI, disabling feature:', error);
      this.isInitialized = false;
    }
  }

  private createRenderTarget(): void {
    if (!this.ssgiResult) {
      this.ssgiResult = new RenderTarget();
    }
    this.ssgiResult.createRT(
      'ssgi_result.dds',
      Render.width * QualitySettings.getInstance().getSettings().ssgiScale,
      Render.height * QualitySettings.getInstance().getSettings().ssgiScale,
      QualitySettings.getInstance().getSettings().hdrTexture,
    );

    if (!this.finalSSGIResult) {
      this.finalSSGIResult = new RenderTarget();
    }
    this.finalSSGIResult.createRT(
      'final_ssgi_result.dds',
      Render.width * QualitySettings.getInstance().getSettings().ssgiScale,
      Render.height * QualitySettings.getInstance().getSettings().ssgiScale,
      QualitySettings.getInstance().getSettings().hdrTexture,
    );
  }

  public render(gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.isInitialized) {
      return;
    }

    this.executeSSRPass(gBufferBindGroup);

    // Pass 2: Apply bilateral filter to the raw AO
    return this.applyBilateralFilter(gBufferBindGroup);
  }

  public executeSSRPass(gBufferBindGroup: GPUBindGroup): void {
    if (!this.isInitialized) return;
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(
      this.ssgiResult.getView(),
      'clear',
      'store',
      {
        r: 0,
        g: 0,
        b: 0,
        a: 1,
      },
    );

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(GPUUtils.createRenderPassDescriptor('ssgi render pass', [colorAttachment]));

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(
      pass,
      Render.width * QualitySettings.getInstance().getSettings().ssgiScale,
      Render.height * QualitySettings.getInstance().getSettings().ssgiScale,
    );

    // 1. Activate pipeline
    this.ssgiTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private applyBilateralFilter(gBufferBindGroup: GPUBindGroup): GPUTextureView {
    this.setupBilateralFilterBindGroup();

    // Use RenderPassManager to execute bilateral filter pass with both bind groups
    this.renderPassManager.executeSSGIBilateralFilterPass(
      this.fullscreenQuadMesh,
      this.bilateralFilterTechnique,
      gBufferBindGroup, // G-Buffer bind group (group 1)
      this.bilateralFilterBindGroup!,
      this.finalSSGIResult,
    );

    return this.finalSSGIResult.getView();
  }

  private setupBilateralFilterBindGroup(): void {
    const sampler = SamplerLibrary.simpleSampler;

    // Create bind group for AO texture (group 2 in the shader) using SingleTexture layout
    this.bilateralFilterBindGroup = BindGroupFactory.createBindGroup(
      `ssgi_bilateral_filter_bindgroup`,
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.ssgiResult.getView()!,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  public dispose(): void {
    this.ssgiResult = null as any;
    this.bilateralFilterBindGroup = null;
    this.createRenderTarget();
  }
}
