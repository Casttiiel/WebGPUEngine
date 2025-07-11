import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { BlurComponent } from './BlurComponent';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassConfig } from '../../renderer/core/passes/BaseRenderPass';
import { PostProcessingRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { Engine } from '../../core/engine/Engine';

/**
 * BloomCombineRenderPass - Custom render pass for combining original image with bloom
 */
class BloomCombineRenderPass extends PostProcessingRenderPass {
  private originalBindGroup: GPUBindGroup;
  private bloomBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    originalBindGroup: GPUBindGroup,
    bloomBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.originalBindGroup = originalBindGroup;
    this.bloomBindGroup = bloomBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Set all bind groups needed for the bloom combine shader
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.originalBindGroup); // Original texture
    pass.setBindGroup(2, this.bloomBindGroup); // Bloom texture
  }
}

export class BloomComponent extends BlurComponent {
  private technique!: Technique;
  private combineTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private combineBindGroup!: GPUBindGroup | null;
  private result!: RenderTarget;
  private finalResult!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // Bloom filter parameters (controlables desde Tweakpane)
  private thresholdMin: number = 1.2;
  private thresholdMax: number = 3.0;
  private emissiveFactor: number = 2.0;

  private bloomParamsBuffer!: GPUBuffer; // Buffer específico para parámetros del filter

  // Additional bind groups for bloom combine operation
  private bloomBindGroup!: GPUBindGroup;
  private bloomFilterParamsBindGroup!: GPUBindGroup | null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public override async load(): Promise<void> {
    // Load parent blur component first
    await super.load();

    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('bloom_filter.tech');
    this.combineTechnique = await Technique.get('bloom_combine.tech');

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.result = new RenderTarget();
    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);

    this.finalResult = new RenderTarget();
    this.finalResult.createRT('bloom_final_result.dds', Render.width, Render.height, bloomFormat);

    // Create uniform buffer specifically for bloom filter parameters
    this.bloomParamsBuffer = GPUUtils.createBuffer(
      'bloom_filter_params_buffer',
      16, // 4 floats * 4 bytes (threshold_min, threshold_max, emissive_factor, padding)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateBloomFilterParams();
  }

  public override resize(): void {
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);
    this.finalResult.createRT('bloom_final_result.dds', Render.width, Render.height, bloomFormat);
    this.bindGroup = null;
    this.combineBindGroup = null;
  }

  private updateBloomFilterParams(): void {
    // Update bloom filter parameters buffer
    const paramsData = new Float32Array([
      this.thresholdMin,
      this.thresholdMax,
      this.emissiveFactor,
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.bloomParamsBuffer, 0, paramsData);
  }

  public generateHighlights(
    gBufferBindGroup: GPUBindGroup,
    texture: GPUTextureView,
  ): GPUTextureView {
    this.setBindGroup(texture);
    this.createBloomFilterParamsBindGroup();

    // Use RenderPassManager to execute bloom filter pass with parameters
    this.renderPassManager.executeBloomFilteringPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.bindGroup!,
      this.result,
      this.bloomFilterParamsBindGroup!,
    );

    const highlightsResult = this.result.getView();

    // Apply multiscaling blur to the highlights
    return this.applyBlur(highlightsResult);
  }

  public addBloom(originalTexture: GPUTextureView, bloomTexture: GPUTextureView): GPUTextureView {
    // Create bind groups for the combine operation
    this.setupCombineBindGroups(originalTexture, bloomTexture);

    // Use the RenderPassFactory to create a post-process pass config
    const passConfig = RenderPassFactory.createPostProcessPassConfig(this.finalResult);

    // Create a bloom combine render pass
    const pass = new BloomCombineRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.combineTechnique,
      this.combineBindGroup!, // Original texture bindgroup
      this.bloomBindGroup!, // Bloom texture bindgroup
    );

    // Execute the custom pass directly using RenderPassManager
    this.renderPassManager.executeDynamicPass(pass);

    // Return the combined result
    return this.finalResult.getView();
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
            buffer: this.bloomParamsBuffer,
          },
        },
      ],
    );
  }

  private setupCombineBindGroups(
    originalTexture: GPUTextureView,
    bloomTexture: GPUTextureView,
  ): void {
    // Create a sampler for texture sampling
    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create bind group for original texture (group 1)
    this.combineBindGroup = BindGroupFactory.createBindGroup(
      `bloom_original_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(1),
      [
        { binding: 0, resource: originalTexture },
        { binding: 1, resource: sampler },
      ],
    );

    // Create bind group for bloom texture (group 2)
    this.bloomBindGroup = BindGroupFactory.createBindGroup(
      `bloom_bloom_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: bloomTexture },
        { binding: 1, resource: sampler },
      ],
    );

    this.createBloomFilterParamsBindGroup();
  }

  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = BindGroupFactory.createBindGroup(
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
      max: 10.0,
      step: 0.1,
    });
    addControl(thresholdMaxWrapper, 'thresholdMax', `${componentName} Filter Threshold Max`, {
      min: 0.5,
      max: 16.0,
      step: 0.1,
    });
    addControl(emissiveFactorWrapper, 'emissiveFactor', `${componentName} Emissive Factor`, {
      min: 0.1,
      max: 10.0,
      step: 0.1,
    });

    // Add controls for inherited blur parameters from BlurComponent using wrapper objects
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
    if (this.finalResult) {
      this.finalResult.destroy();
    }
    if (this.bloomParamsBuffer) {
      this.bloomParamsBuffer.destroy();
    }
  }
}
