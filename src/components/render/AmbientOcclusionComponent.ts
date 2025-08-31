import { Component } from '../../core/ecs/Component';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { Render } from '../../renderer/core/pipeline/Render';
import { Texture } from '../../renderer/resources/Texture';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

export class AmbientOcclusionComponent extends Component {
  private aoTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private temporalAccumulationTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets for the two-pass process
  private rawAOTarget!: RenderTarget;
  private finalAOResult!: RenderTarget;
  private temporalAccumulationTarget!: RenderTarget;
  private temporalAccumulationResult!: RenderTarget;

  // Uniform buffer for SSAO parameters
  private ssaoParamsBuffer!: GPUBuffer;
  private ssaoParamsBindGroup!: GPUBindGroup | null;
  private bilateralFilterBindGroup!: GPUBindGroup | null;
  private rawAOBindGroup!: GPUBindGroup | null;
  private temporalAccumulationResultBindGroup!: GPUBindGroup | null;
  private isEnabled = true;
  private noiseTexture!: Texture;

  private jitterIndex = 0;
  private jitterSequence = [
    [0.0, 0.0],
    [1.1, -0.7],
    [2.2, 0.2],
    [3.3, -0.5],
    [4.3, 0.4],
    [5.3, -0.3],
    [6.3, 0.6],
    [7.3, -0.1],
  ];

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();

    this.isEnabled = QualitySettings.getInstance().getSettings().enableAO;
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.aoTechnique = await Technique.get('ambient_occlusion.tech');
    this.bilateralFilterTechnique = await Technique.get('ao_bilateral_filter.tech');
    this.temporalAccumulationTechnique = await Technique.get('ao_temporal_accumulation.tech');
    this.noiseTexture = await Texture.get('noiseRGB.jpg');

    const aoFormat = QualitySettings.getInstance().getSettings().aoTexture;

    const aoScale = QualitySettings.getInstance().getSettings().aoScale;
    const aoWidth = Math.floor(Render.width * aoScale);
    const aoHeight = Math.floor(Render.height * aoScale);

    // Raw AO at reduced resolution (50%)
    this.rawAOTarget = new RenderTarget();
    this.rawAOTarget.createRT('raw_ao_result.dds', aoWidth, aoHeight, aoFormat);

    // Bilateral filter also at reduced resolution (50%)
    this.finalAOResult = new RenderTarget();
    this.finalAOResult.createRT('final_ao_result.dds', aoWidth, aoHeight, aoFormat);

    this.temporalAccumulationResult = new RenderTarget();
    this.temporalAccumulationResult.createRT(
      'temporal_accumulation_result.dds',
      aoWidth,
      aoHeight,
      aoFormat,
    );

    this.temporalAccumulationTarget = new RenderTarget();
    this.temporalAccumulationTarget.createRT(
      'temporal_accumulation_target.dds',
      aoWidth,
      aoHeight,
      aoFormat,
    );

    this.createSSAOParamsBuffer();
    this.createSSAOParamsBindGroup();
  }

  public resize(): void {
    const aoFormat = QualitySettings.getInstance().getSettings().aoTexture;

    const aoScale = QualitySettings.getInstance().getSettings().aoScale;
    const aoWidth = Math.floor(Render.width * aoScale);
    const aoHeight = Math.floor(Render.height * aoScale);

    this.bilateralFilterBindGroup = null;
    this.rawAOBindGroup = null;

    if (this.rawAOTarget) {
      this.rawAOTarget.destroy();
    }
    if (this.finalAOResult) {
      this.finalAOResult.destroy();
    }

    if (this.temporalAccumulationTarget) {
      this.temporalAccumulationTarget.destroy();
    }
    if (this.temporalAccumulationResult) {
      this.temporalAccumulationResult.destroy();
    }

    // Recreate both targets at reduced resolution
    this.rawAOTarget.createRT('raw_ao_result.dds', aoWidth, aoHeight, aoFormat);
    this.finalAOResult.createRT('final_ao_result.dds', aoWidth, aoHeight, aoFormat);
    this.temporalAccumulationTarget.createRT(
      'temporal_accumulation_target.dds',
      aoWidth,
      aoHeight,
      aoFormat,
    );
    this.temporalAccumulationResult.createRT(
      'temporal_accumulation_result.dds',
      aoWidth,
      aoHeight,
      aoFormat,
    );
  }

  private createSSAOParamsBuffer(): void {
    // Create buffer with enough space for SSAO parameters only
    // 4 floats = 16
    this.ssaoParamsBuffer = GPUUtils.createBuffer(
      'SSAO Parameters Buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Creamos un ArrayBuffer para almacenar tanto u32 como f32
    const arrayBuffer = new ArrayBuffer(16); // 8 * 4 bytes (1 u32 + 5 f32 + 2 padding)
    const u32View = new Uint32Array(arrayBuffer, 0, 1);
    const f32View = new Float32Array(arrayBuffer, 4); // Comienza después del u32

    const qualitySettings = QualitySettings.getInstance().getSettings();
    u32View[0] = qualitySettings.aoSampleCount;
    f32View[0] = qualitySettings.aoRadius;
    f32View[1] = qualitySettings.aoStrength;
    f32View[2] = qualitySettings.aoNoiseScale;

    const paramsData = new Uint8Array(arrayBuffer);
    GPUUtils.writeBuffer(this.ssaoParamsBuffer, 0, paramsData);
  }

  private createSSAOParamsBindGroup(): void {
    const sampler = SamplerLibrary.ambientOcclusionSampler;

    this.ssaoParamsBindGroup = BindGroupFactory.createBindGroup(
      'ssao_params_bindgroup',
      this.aoTechnique.getBindGroupLayout(2)!,
      [
        {
          binding: 0,
          resource: {
            buffer: this.ssaoParamsBuffer,
          },
        },
        {
          binding: 1,
          resource: sampler,
        },
        {
          binding: 2,
          resource: this.noiseTexture.getTextureView()!,
        },
      ],
    );
  }

  private renderDisabledAO(): GPUTextureView {
    // When AO is disabled, we need to fill the target with white (no occlusion)
    // This ensures the lighting calculations work correctly

    const commandEncoder = Render.getInstance().getCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear AO Target',
      colorAttachments: [
        {
          view: this.rawAOTarget.getView(),
          clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }, // White = no occlusion
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.end();

    return this.rawAOTarget.getView();
  }

  public compute(gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.isEnabled) {
      return this.renderDisabledAO();
    }

    // Pass 1: Generate raw AO using SSAO with parameters
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.aoTechnique,
      gBufferBindGroup,
      this.ssaoParamsBindGroup!,
      this.rawAOTarget,
    );

    this.renderTemporalAccumulation();

    // Pass 2: Apply bilateral filter to the raw AO
    return this.applyBilateralFilter(gBufferBindGroup);
  }

  private renderTemporalAccumulation(): void {
    this.setupRawAOBindGroup();
    this.setupTemporalAccumulationResultBindGroup();
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(
      this.temporalAccumulationTarget.getView(),
    );

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('AO Temporal Accumulation Pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(
      pass,
      Render.width * QualitySettings.getInstance().getSettings().aoScale,
      Render.height * QualitySettings.getInstance().getSettings().aoScale,
    );

    // 1. Activate pipeline
    this.temporalAccumulationTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, this.rawAOBindGroup);
    pass.setBindGroup(1, this.temporalAccumulationResultBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();

    //Switch target and result for next frame
    const temp = this.temporalAccumulationResult;
    this.temporalAccumulationResult = this.temporalAccumulationTarget;
    this.temporalAccumulationTarget = temp;
  }

  private applyBilateralFilter(gBufferBindGroup: GPUBindGroup): GPUTextureView {
    this.setupBilateralFilterBindGroup();

    // Use RenderPassManager to execute bilateral filter pass with both bind groups
    this.renderPassManager.executeAOBilateralFilterPass(
      this.fullscreenQuadMesh,
      this.bilateralFilterTechnique,
      gBufferBindGroup, // G-Buffer bind group (group 1)
      this.bilateralFilterBindGroup!,
      this.finalAOResult,
    );

    return this.finalAOResult.getView();
  }

  private setupBilateralFilterBindGroup(): void {
    const sampler = SamplerLibrary.simpleSampler;

    // Create bind group for AO texture (group 2 in the shader) using SingleTexture layout
    this.bilateralFilterBindGroup = BindGroupFactory.createBindGroup(
      `ao_bilateral_filter_bindgroup`,
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.temporalAccumulationResult.getView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  private setupRawAOBindGroup(): void {
    if (this.rawAOBindGroup) return;

    const sampler = SamplerLibrary.simpleSampler;

    // Create bind group for AO texture using SingleTexture layout
    this.rawAOBindGroup = BindGroupFactory.createBindGroup(
      `raw_ao_bindgroup`,
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
      ],
    );
  }

  private setupTemporalAccumulationResultBindGroup(): void {
    const sampler = SamplerLibrary.simpleSampler;

    // Create bind group for AO texture using SingleTexture layout
    this.temporalAccumulationResultBindGroup = BindGroupFactory.createBindGroup(
      `temporalAccumulationResult_bindgroup`,
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.temporalAccumulationResult.getView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  public update(_dt: number): void {
    const [angle, spacial] = this.jitterSequence[this.jitterIndex];
    this.jitterIndex = (this.jitterIndex + 1) % this.jitterSequence.length;
    GPUUtils.writeBuffer(this.ssaoParamsBuffer, 16, new Float32Array([angle, spacial, 0, 0]));
  }

  public override renderInMenu(): void {}

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
