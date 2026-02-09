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
import { Engine } from '../../core/engine/Engine';

export class AmbientOcclusionComponent extends Component {
  private device: GPUDevice;
  private loaded = false;
  private aoTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets for the two-pass process
  private rawAOTarget!: RenderTarget;
  private finalAOResult!: RenderTarget;

  // Uniform buffer for SSAO parameters
  private ssaoParamsBuffer!: GPUBuffer;
  private ssaoParamsBindGroup!: GPUBindGroup | null;
  private bilateralFilterBindGroup!: GPUBindGroup | null;
  private isEnabled = true;
  private noiseTexture!: Texture;
  private ssaoUniformData: Float32Array;
  private sampleCount: number = QualitySettings.getInstance().getSettings().aoSampleCount;
  private sliceCount: number = QualitySettings.getInstance().getSettings().aoSliceCount;
  private radius: number = QualitySettings.getInstance().getSettings().aoRadius;
  private strength: number = QualitySettings.getInstance().getSettings().aoStrength;
  private angleOffset: number = 0.1;
  private spacialOffset: number = 0.66;
  private falloff: number = 1.0;
  private thicknessMix: number = 0.001;
  private maxStride: number = 5.0;
  private limit: number = 20.0;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
    this.device = GPUUtils.getDevice();
    this.isEnabled = QualitySettings.getInstance().getSettings().enableAO;
    this.ssaoUniformData = new Float32Array(12);
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.aoTechnique = await Technique.getAsync('post-processing/ambient_occlusion.tech');
    this.bilateralFilterTechnique = await Technique.getAsync(
      'post-processing/ao_bilateral_filter.tech',
    );
    this.noiseTexture = await Texture.getAsync('noiseRGB.jpg');

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

    this.createSSAOParamsBuffer();
    this.createSSAOParamsBindGroup();

    this.loaded = true;
  }

  public resize(): void {
    const aoFormat = QualitySettings.getInstance().getSettings().aoTexture;

    const aoScale = QualitySettings.getInstance().getSettings().aoScale;
    const aoWidth = Math.floor(Render.width * aoScale);
    const aoHeight = Math.floor(Render.height * aoScale);

    this.bilateralFilterBindGroup = null;

    if (this.rawAOTarget) {
      this.rawAOTarget.destroy();
    }
    if (this.finalAOResult) {
      this.finalAOResult.destroy();
    }

    // Recreate both targets at reduced resolution
    this.rawAOTarget.createRT('raw_ao_result.dds', aoWidth, aoHeight, aoFormat);
    this.finalAOResult.createRT('final_ao_result.dds', aoWidth, aoHeight, aoFormat);
  }

  private createSSAOParamsBuffer(): void {
    // Create buffer with enough space for SSAO parameters only
    this.ssaoParamsBuffer = GPUUtils.createBuffer(
      'SSAO Parameters Buffer',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
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

    this.updateUniforms();

    // Pass 1: Generate raw AO using SSAO with parameters
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.aoTechnique,
      gBufferBindGroup,
      this.ssaoParamsBindGroup!,
      this.rawAOTarget,
    );

    // Pass 2: Apply bilateral filter to the raw AO
    return this.applyBilateralFilter(gBufferBindGroup);
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
          resource: this.rawAOTarget.getView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  private updateUniforms(): void {
    let offset = 0;
    this.ssaoUniformData[offset++] = this.sampleCount;
    this.ssaoUniformData[offset++] = this.sliceCount;
    this.ssaoUniformData[offset++] = this.radius;
    this.ssaoUniformData[offset++] = this.strength;
    this.ssaoUniformData[offset++] = this.angleOffset;
    this.ssaoUniformData[offset++] = this.spacialOffset;
    this.ssaoUniformData[offset++] = this.falloff;
    this.ssaoUniformData[offset++] = this.thicknessMix;
    this.ssaoUniformData[offset++] = this.maxStride;
    this.ssaoUniformData[offset++] = this.limit;

    // Upload to GPU
    if (this.ssaoParamsBuffer) {
      this.device.queue.writeBuffer(this.ssaoParamsBuffer, 0, this.ssaoUniformData.buffer);
    }
  }

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // Create/get the Volumetric Scattering folder
    if (!gui.beginWindow('Ambient Occlusion', true)) return;

    // Access the folder from GUIManager's internal map
    const guiManager = gui as any;
    const folder = guiManager.folders?.get('Ambient Occlusion');

    if (!folder) {
      gui.endWindow();
      return;
    }

    folder.add(this, 'isEnabled').name('Enable AO').listen();

    folder.add(this, 'sampleCount', 1.0, 16.0).name('Sample Count').listen();

    folder.add(this, 'sliceCount', 1.0, 8.0).name('Slice Count').listen();

    folder.add(this, 'radius', 0.0, 5.0).name('Radius').listen();

    folder.add(this, 'strength', 0.0, 2.0).name('Strength').listen();

    folder.add(this, 'angleOffset', 0.0, 3.0).name('Angle Offset').listen();

    folder.add(this, 'spacialOffset', 0.0, 3.0).name('Spacial Offset').listen();

    folder.add(this, 'falloff', 0.0, 15.0).name('Falloff').listen();

    folder.add(this, 'thicknessMix', 0.001, 0.01).name('Thickness Mix').listen();

    folder.add(this, 'maxStride', 1.0, 32.0).name('Max Stride').listen();

    folder.add(this, 'limit', 0.0, 100.0).name('Limit').listen();

    gui.endWindow();
  }

  public update(_dt: number): void {}

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
