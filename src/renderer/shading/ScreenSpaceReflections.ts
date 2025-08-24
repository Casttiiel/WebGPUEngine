import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Mesh } from '../resources/Mesh';
import { RenderTarget } from '../resources/RenderTarget';
import { Technique } from '../resources/Technique';

export class ScreenSpaceReflections {
  private isInitialized: boolean = false;
  private fullscreenQuadMesh!: Mesh;
  private ssrTechnique!: Technique;
  private ssrComposeTechnique!: Technique;
  public ssrResult!: RenderTarget;
  private ssrBindGroup!: GPUBindGroup;
  private ssrComposeBindGroup!: GPUBindGroup;
  private ssrUniformBuffer!: GPUBuffer;

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.isInitialized = true;
      this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
      this.ssrTechnique = await Technique.get('ssr.tech');
      this.ssrComposeTechnique = await Technique.get('ssr_compose.tech');
      if (!this.ssrResult) {
        this.ssrResult = new RenderTarget();
      }
      this.ssrResult.createRT(
        'ssr_result.dds',
        Render.width * QualitySettings.getInstance().getSettings().ssrScale,
        Render.height * QualitySettings.getInstance().getSettings().ssrScale,
        QualitySettings.getInstance().getSettings().hdrTexture,
      );

      this.ssrUniformBuffer = GPUUtils.createBuffer(
        'ssr uniform buffer',
        32,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      const qualitySettings = QualitySettings.getInstance().getSettings();

      GPUUtils.writeBuffer(
        this.ssrUniformBuffer,
        0,
        new Float32Array([
          1.0,
          qualitySettings.ssrStepSize,
          qualitySettings.ssrMaxSteps,
          50.0,
          0.03,
          1.0,
        ]),
      );

      console.log('SSR loaded successfully');
    } catch (error) {
      console.warn('Failed to load SSR, disabling feature:', error);
      this.isInitialized = false;
    }
  }

  public render(accLights: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    if (!this.isInitialized) {
      return;
    }
    if (!this.ssrBindGroup) {
      this.createSSRBindGroup(accLights);
    }
    if (!this.ssrComposeBindGroup) {
      this.createSSRComposeBindGroup(this.ssrResult.getView());
    }

    this.executeSSRPass(gBufferBindGroup);
    this.composeSSR(accLights);
  }

  public executeSSRPass(gBufferBindGroup: GPUBindGroup): void {
    if (!this.isInitialized) return;
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(
      this.ssrResult.getView(),
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
      .beginRenderPass(GPUUtils.createRenderPassDescriptor('ssr render pass', [colorAttachment]));

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(
      pass,
      Render.width * QualitySettings.getInstance().getSettings().ssrScale,
      Render.height * QualitySettings.getInstance().getSettings().ssrScale,
    );

    // 1. Activate pipeline
    this.ssrTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ssrBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public composeSSR(accLights: GPUTextureView): void {
    if (!this.isInitialized) return;
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(accLights, 'load', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('ssr compose render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass, Render.width, Render.height);

    // 1. Activate pipeline
    this.ssrComposeTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, this.ssrComposeBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createSSRBindGroup(accLights: GPUTextureView) {
    this.ssrBindGroup = BindGroupFactory.createBindGroup(
      'ssr_bindgroup',
      this.ssrTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: accLights,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: { buffer: this.ssrUniformBuffer },
        },
      ],
    );
  }

  private createSSRComposeBindGroup(ssr: GPUTextureView) {
    this.ssrComposeBindGroup = BindGroupFactory.createBindGroup(
      'ssr_compose_bindgroup',
      this.ssrComposeTechnique.getPipeline().getBindGroupLayout(0),
      [
        {
          binding: 0,
          resource: ssr,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
      ],
    );
  }

  public dispose(): void {
    this.isInitialized = false;
  }
}
