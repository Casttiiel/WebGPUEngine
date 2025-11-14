import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Mesh } from '../resources/Mesh';
import { RenderTarget } from '../resources/RenderTarget';
import { Technique } from '../resources/Technique';
import { Texture } from '../resources/Texture';

export class ScreenSpaceReflections {
  private isInitialized: boolean = false;
  private fullscreenQuadMesh!: Mesh;
  private ssrTechnique!: Technique;
  private ssrComposeTechnique!: Technique;
  private ssrResult!: RenderTarget;
  private ssrBindGroup!: GPUBindGroup;
  private ssrComposeBindGroup!: GPUBindGroup;
  private ssrUniformBuffer!: GPUBuffer;
  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.isInitialized = true;
      this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
      this.ssrTechnique = await Technique.getAsync('ssr.tech');
      this.ssrComposeTechnique = await Technique.getAsync('ssr_compose.tech');
      this.brdfLUT = await Texture.getAsync('brdfLUT.png');

      this.createRenderTarget();

      this.ssrUniformBuffer = GPUUtils.createBuffer(
        'ssr uniform buffer',
        32,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      console.log('SSR loaded successfully');
    } catch (error) {
      console.warn('Failed to load SSR, disabling feature:', error);
      this.isInitialized = false;
    }
  }

  private createRenderTarget(): void {
    if (!this.ssrResult) {
      this.ssrResult = new RenderTarget();
    }
    this.ssrResult.createRT(
      'ssr_result.dds',
      Render.width * QualitySettings.getInstance().getSettings().ssrScale,
      Render.height * QualitySettings.getInstance().getSettings().ssrScale,
      QualitySettings.getInstance().getSettings().hdrTexture,
    );
  }

  public render(
    accLights: GPUTextureView,
    ao: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
  ): void {
    if (!this.isInitialized) {
      return;
    }
    if (!this.ssrBindGroup) {
      this.createSSRBindGroup(accLights, ao);
    }
    if (!this.ssrComposeBindGroup) {
      this.createSSRComposeBindGroup(this.ssrResult.getView(), ao);
    }

    this.executeSSRPass(gBufferBindGroup);
    this.composeSSR(accLights, gBufferBindGroup);
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

  public composeSSR(accLights: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
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
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ssrComposeBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  private createSSRBindGroup(accLights: GPUTextureView, ao: GPUTextureView) {
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
          resource: ao,
        },
        {
          binding: 2,
          resource: this.brdfLUT.getTextureView()!,
        },
        {
          binding: 3,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 4,
          resource: { buffer: this.ssrUniformBuffer },
        },
      ],
    );
  }

  private createSSRComposeBindGroup(ssr: GPUTextureView, ao: GPUTextureView) {
    this.ssrComposeBindGroup = BindGroupFactory.createBindGroup(
      'ssr_compose_bindgroup',
      this.ssrComposeTechnique.getPipeline().getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: ssr,
        },
        {
          binding: 1,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 2,
          resource: ao,
        },
        {
          binding: 3,
          resource: this.brdfLUT.getTextureView()!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler!,
        },
        {
          binding: 5,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getTextureView()!,
        },
        {
          binding: 6,
          resource: Engine.getEnvironmentManager().getSSREnvironmentTexture().getSampler()!,
        },
        {
          binding: 7,
          resource: { buffer: this.ssrUniformBuffer },
        },
      ],
    );
  }

  public update(dt: number): void {
    const qualitySettings = QualitySettings.getInstance().getSettings();

    GPUUtils.writeBuffer(
      this.ssrUniformBuffer,
      0,
      new Float32Array([
        Engine.getEnvironmentManager().getAmbientLightData().globalFactor,
        qualitySettings.ssrStepSize,
        qualitySettings.ssrMaxSteps,
        50.0,
        0.03,
        1.0,
        Engine.getEnvironmentManager().getAmbientLightData().reflectionFactor,
        Engine.getEnvironmentManager().getAmbientLightData().diffuseFactor,
      ]),
    );
  }

  public dispose(): void {
    this.ssrBindGroup = null as any;
    this.ssrComposeBindGroup = null as any;
    this.ssrResult = null as any;
    this.createRenderTarget();
  }
}
