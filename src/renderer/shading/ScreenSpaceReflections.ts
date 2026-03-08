import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { RenderTarget } from '../resources/RenderTarget';
import { Texture } from '../resources/Texture';

export class ScreenSpaceReflections {
  private isInitialized: boolean = false;

  // Compute resources
  private ssrComputePipeline: GPUComputePipeline | null = null;
  private ssrParamsLayout: GPUBindGroupLayout | null = null;
  private ssrOutputLayout: GPUBindGroupLayout | null = null;

  // Render targets
  private ssrResult!: RenderTarget;

  // Bind groups
  private ssrBindGroup: GPUBindGroup | null = null;
  private ssrOutputBindGroup: GPUBindGroup | null = null;
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;

  // Buffers / textures
  private ssrUniformBuffer!: GPUBuffer;
  private brdfLUT!: Texture;

  constructor() {}

  public async load(): Promise<void> {
    try {
      this.isInitialized = false;
      this.brdfLUT = await Texture.getAsync('brdfLUT.png');

      this.createRenderTarget();

      this.ssrUniformBuffer = GPUUtils.createBuffer(
        'ssr uniform buffer',
        32,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );

      await this.createComputePipeline();

      console.log('SSR loaded successfully (compute)');
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
      // STORAGE_BINDING required so the compute shader can write directly
      GPUTextureUsage.STORAGE_BINDING,
    );
    // Invalidate output bind group — it references the old texture view
    this.ssrOutputBindGroup = null;
  }

  // ─── Compute pipeline setup ────────────────────────────────────────────────

  private async createComputePipeline(): Promise<void> {
    const device = GPUUtils.getDevice();

    // Layouts
    const cameraLayout = BindGroupFactory.getCameraComputeLayout();
    const gbufferLayout = BindGroupFactory.getGBufferComputeLayout();
    this.ssrParamsLayout = BindGroupFactory.getSSRUniformsComputeLayout();
    this.ssrOutputLayout = BindGroupFactory.getSSROutputLayout();

    // Shader
    const shaderCode = await ResourceManager.loadShader('post-processing/ssr.cs');
    const shaderModule = device.createShaderModule({ label: 'ssr_cs', code: shaderCode });

    const config: ComputePipelineConfig = {
      label: 'SSR Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('ssr_compute_pipeline_layout', [
        cameraLayout,
        gbufferLayout,
        this.ssrParamsLayout,
        this.ssrOutputLayout,
      ]),
      compute: { module: shaderModule, entryPoint: 'cs' },
    };

    this.ssrComputePipeline = PipelineFactory.createComputePipeline(config);
  }

  private renderDisabledSSR(): GPUTextureView {
    const commandEncoder = Render.getInstance().getCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear AO Target',
      colorAttachments: [
        {
          view: this.ssrResult.getView(),
          clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 0.0 }, // White = no reflection
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.end();

    return this.ssrResult.getView();
  }

  public generateSSR(
    accLights: GPUTextureView,
    ao: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
  ): GPUTextureView {
    if (!QualitySettings.getInstance().getSettings().ssrEnabled) {
      return this.renderDisabledSSR();
    }

    if (!this.ssrBindGroup) {
      this.createSSRBindGroup(accLights, ao);
    }

    this.executeSSRPass(gBufferBindGroup);

    return this.ssrResult.getView();
  }

  public executeSSRPass(gBufferBindGroup: GPUBindGroup): void {
    if (!this.isInitialized || !this.ssrComputePipeline) return;

    const qs = QualitySettings.getInstance().getSettings();
    const ssrW = Math.floor(Render.width * qs.ssrScale);
    const ssrH = Math.floor(Render.height * qs.ssrScale);

    // ── Camera compute bind group (lazily created / refreshed) ───────────────
    const cameraBuffer = Engine.getRender().getMainCamera().getUniformBuffer();
    if (!cameraBuffer) return;
    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'ssr_camera_compute_bindgroup',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }

    // ── Output bind group (lazily created / invalidated on resize) ────────────
    if (!this.ssrOutputBindGroup) {
      this.ssrOutputBindGroup = BindGroupFactory.createBindGroup(
        'ssr_output_bindgroup',
        this.ssrOutputLayout!,
        [{ binding: 0, resource: this.ssrResult.getStorageView() }],
      );
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    const encoder = Render.getInstance().getCommandEncoder();
    const pass = encoder.beginComputePass({ label: 'SSR Compute' });

    pass.setPipeline(this.ssrComputePipeline);
    pass.setBindGroup(0, this.cameraComputeBindGroup);
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.ssrBindGroup!);
    pass.setBindGroup(3, this.ssrOutputBindGroup);

    pass.dispatchWorkgroups(Math.ceil(ssrW / 8), Math.ceil(ssrH / 8), 1);
    pass.end();
  }

  public composeSSR(): void {
    if (!this.isInitialized) return;
  }

  public getBRDFLUT(): Texture {
    return this.brdfLUT;
  }

  private createSSRBindGroup(accLights: GPUTextureView, ao: GPUTextureView) {
    this.ssrBindGroup = BindGroupFactory.createBindGroup('ssr_bindgroup', this.ssrParamsLayout!, [
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
    ]);
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
    this.ssrBindGroup = null;
    this.ssrOutputBindGroup = null;
    this.cameraComputeBindGroup = null;
    this.lastCameraBuffer = null;
    this.ssrResult = null as any;
    this.createRenderTarget();
  }
}
