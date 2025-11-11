import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { BloomCombineRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Texture } from '../../renderer/resources/Texture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BlurComponent } from './BlurComponent';

export class BloomComponent extends BlurComponent {
  private whiteTexture!: Texture;
  private technique!: Technique;
  private combineTechnique!: Technique;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // Bloom filter parameters (controlables desde Tweakpane)
  private thresholdMin: number = 12.0; // Más alto para evitar specular común
  private thresholdMax: number = 0.7; // Threshold más alto para HDR
  private emissiveFactor: number = 2.0;

  // Additional bind groups for bloom combine operation
  private inputTextureBindGroup!: GPUBindGroup | null;

  private bloomCombineParamsBuffer!: GPUBuffer; // Buffer específico para parámetros del combine
  private bloomCombineParamsBindGroup!: GPUBindGroup | null;
  private bloomFiltersParamsBuffer!: GPUBuffer; // Buffer específico para parámetros del filter
  private bloomFilterParamsBindGroup!: GPUBindGroup | null;

  private bloomTexturesBindGroup!: GPUBindGroup | null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public override async load(): Promise<void> {
    // Load parent blur component first
    await super.load();

    this.whiteTexture = await Texture.getAsync('white.png');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('bloom_filter.tech');
    this.combineTechnique = await Technique.getAsync('bloom_combine.tech');

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getSettings().bloomTexture;

    this.result = new RenderTarget();
    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);

    // Create uniform buffer specifically for bloom filter parameters
    this.bloomFiltersParamsBuffer = GPUUtils.createBuffer(
      'bloom_filter_params_buffer',
      16, // 4 floats * 4 bytes (threshold_min, threshold_max, emissive_factor, padding)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create uniform buffer specifically for bloom combine parameters
    this.bloomCombineParamsBuffer = GPUUtils.createBuffer(
      'bloom_combine_params_buffer',
      16, // 4 floats * 4 bytes (threshold_min, threshold_max, emissive_factor, padding)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateBloomFilterParams();
    this.updateBloomCombineParams();
  }

  public override resize(): void {
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getSettings().bloomTexture;

    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);
    this.inputTextureBindGroup = null;
    this.bloomTexturesBindGroup = null;
  }

  private updateBloomFilterParams(): void {
    // Update bloom filter parameters buffer
    const paramsData = new Float32Array([
      this.thresholdMin,
      this.thresholdMax,
      this.emissiveFactor,
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.bloomFiltersParamsBuffer, 0, paramsData);
  }

  private updateBloomCombineParams(): void {
    // Update bloom combine parameters buffer
    const paramsData = new Float32Array([
      1.0,
      this.maxBlurSteps > 1 ? 0.8 : 0.0,
      this.maxBlurSteps > 2 ? 0.64 : 0.0,
      this.maxBlurSteps > 3 ? 0.512 : 0.0,
    ]);

    GPUUtils.writeBuffer(this.bloomCombineParamsBuffer, 0, paramsData);
  }

  public generateHighlights(
    gBufferBindGroup: GPUBindGroup,
    inputTexture: GPUTextureView,
  ): GPUTextureView {
    this.setInputTextureBindGroup(inputTexture);
    this.createBloomFilterParamsBindGroup();

    // Use RenderPassManager to execute bloom filter pass with parameters
    this.renderPassManager.executeBloomFilteringPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.inputTextureBindGroup!,
      this.result,
      this.bloomFilterParamsBindGroup!,
    );

    const highlightsResult = this.result.getView();
    this.applyBlur(highlightsResult);

    return this.result.getView();
  }

  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    // Generate bloom highlights from input texture using G-Buffer data
    this.generateHighlights(gBufferBindGroup, inputTexture);

    // Add bloom to original texture
    this.addBloom(inputTexture);

    // Return the original texture (bloom is applied directly to it)
    return inputTexture;
  }

  public hasLoaded(): boolean {
    return (
      this.technique !== undefined &&
      this.combineTechnique !== undefined &&
      this.whiteTexture !== undefined &&
      this.fullscreenQuadMesh !== undefined &&
      this.result !== undefined
    );
  }

  public addBloom(originalTexture: GPUTextureView): void {
    // Create bind groups for the combine operation
    this.setupCombineBindGroups();

    // Use the RenderPassFactory to create a post-process pass config
    const passConfig = RenderPassFactory.createBloomCombinePassConfig(originalTexture);

    // Create a bloom combine render pass
    const pass = new BloomCombineRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.combineTechnique,
      this.bloomCombineParamsBindGroup!,
      this.bloomTexturesBindGroup!,
    );

    // Execute the custom pass directly using RenderPassManager
    this.renderPassManager.executeDynamicPass(pass);
  }

  private createBloomFilterParamsBindGroup(): void {
    if (this.bloomFilterParamsBindGroup) return;

    this.bloomFilterParamsBindGroup = BindGroupFactory.createBindGroup(
      'bloom_filter_params_bindgroup',
      BindGroupFactory.getBufferUniformLayout(),
      [
        {
          binding: 0,
          resource: {
            buffer: this.bloomFiltersParamsBuffer,
          },
        },
      ],
    );
  }

  private setupCombineBindGroups(): void {
    // Create a sampler for texture sampling
    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bloomCombineParamsBindGroup = BindGroupFactory.createBindGroup(
      `bloom_combine_params_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(0),
      [
        {
          binding: 0,
          resource: {
            buffer: this.bloomCombineParamsBuffer,
          },
        },
      ],
    );

    const bindGroupData = [
      { binding: 0, resource: sampler },
      {
        binding: 1,
        resource: this.steps[0]
          ? this.steps[0].getOutputView()
          : this.whiteTexture.getTextureView()!,
      },
      {
        binding: 2,
        resource: this.steps[1]
          ? this.steps[1].getOutputView()
          : this.whiteTexture.getTextureView()!,
      },
      {
        binding: 3,
        resource: this.steps[2]
          ? this.steps[2].getOutputView()
          : this.whiteTexture.getTextureView()!,
      },
      {
        binding: 4,
        resource: this.steps[3]
          ? this.steps[3].getOutputView()
          : this.whiteTexture.getTextureView()!,
      },
    ];

    this.bloomTexturesBindGroup = BindGroupFactory.createBindGroup(
      `bloom_textures_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(1),
      bindGroupData,
    );
  }

  private setInputTextureBindGroup(texture: GPUTextureView): void {
    if (this.inputTextureBindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.inputTextureBindGroup = BindGroupFactory.createBindGroup(
      `bloom_bindgroup`,
      this.technique.getPipeline().getBindGroupLayout(2),
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
  }

  // Inherit blur parameter controls from parent
  public override setMaxBlurSteps(steps: number): void {
    super.setMaxBlurSteps(steps);
    this.updateBloomCombineParams();
  }

  public override setBlurStrength(strength: number): void {
    super.setBlurStrength(strength);
  }

  public override update(_dt: number): void {
    // Update bloom parameters if needed
  }

  public debugInMenu(): void {
    // Implement debug menu for bloom parameters
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'render';
    const subfolderKey = 'Camera Components';
    const componentName = 'Bloom';

    // Declare self at the beginning to avoid reference errors
    const self = this;

    // Add controls to the Camera Components subfolder
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Add controls for bloom filter parameters
    const thresholdMinWrapper = {
      get thresholdMin() {
        return self.thresholdMin;
      },
      set thresholdMin(value) {
        self.thresholdMin = value;
        self.updateBloomFilterParams();
        self.bloomFilterParamsBindGroup = null; // Force recreation
      },
    };

    const thresholdMaxWrapper = {
      get thresholdMax() {
        return self.thresholdMax;
      },
      set thresholdMax(value) {
        self.thresholdMax = value;
        self.updateBloomFilterParams();
        self.bloomFilterParamsBindGroup = null; // Force recreation
      },
    };

    const emissiveFactorWrapper = {
      get emissiveFactor() {
        return self.emissiveFactor;
      },
      set emissiveFactor(value) {
        self.emissiveFactor = value;
        self.updateBloomFilterParams();
        self.bloomFilterParamsBindGroup = null; // Force recreation
      },
    };

    addControl(thresholdMinWrapper, 'thresholdMin', `${componentName} Filter Threshold Min`, {
      min: 0.0,
      max: 50.0,
      step: 0.1,
    });
    addControl(thresholdMaxWrapper, 'thresholdMax', `${componentName} Filter Threshold Max`, {
      min: 0.5,
      max: 100.0,
      step: 0.1,
    });
    addControl(emissiveFactorWrapper, 'emissiveFactor', `${componentName} Emissive Factor`, {
      min: 0.1,
      max: 10.0,
      step: 0.1,
    });

    const blurStrengthWrapper = {
      get blurStrength() {
        return self.getBlurStrength();
      },
      set blurStrength(value) {
        self.setBlurStrength(value);
      },
    };

    const maxBlurStepsWrapper = {
      get maxBlurSteps() {
        return self.getMaxBlurSteps();
      },
      set maxBlurSteps(value) {
        self.setMaxBlurSteps(value);
      },
    };

    addControl(blurStrengthWrapper, 'blurStrength', `${componentName} Blur Strength`, {
      min: 0.0,
      max: 10.0,
      step: 0.1,
    });
    addControl(maxBlurStepsWrapper, 'maxBlurSteps', `${componentName} Max Blur Steps`, {
      min: 1,
      max: 20,
      step: 1,
    });
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
