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
  private paramsBindGroup: GPUBindGroup;

  constructor(
    config: RenderPassConfig,
    mesh: Mesh,
    technique: Technique,
    originalBindGroup: GPUBindGroup,
    bloomBindGroup: GPUBindGroup,
    paramsBindGroup: GPUBindGroup,
  ) {
    super(config, mesh, technique);
    this.originalBindGroup = originalBindGroup;
    this.bloomBindGroup = bloomBindGroup;
    this.paramsBindGroup = paramsBindGroup;
  }

  protected setBindGroups(pass: GPURenderPassEncoder): void {
    // Set all bind groups needed for the bloom combine shader
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.originalBindGroup); // Original texture
    pass.setBindGroup(2, this.bloomBindGroup); // Bloom texture
    pass.setBindGroup(3, this.paramsBindGroup); // Bloom parameters
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

  // Bloom parameters
  private bloomIntensity: number = 1.0;
  private bloomThreshold: number = 1.0;
  private bloomKnee: number = 0.5;
  private bloomRadius: number = 1.0;
  private uniformBuffer!: GPUBuffer;

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

    // Create uniform buffer for bloom parameters
    this.uniformBuffer = GPUUtils.createBuffer(
      'bloom_params_buffer',
      16, // 4 floats * 4 bytes
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateBloomParams();
  }

  public override resize(): void {
    // Call parent resize
    super.resize();

    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.result.createRT('bloom_filter_result.dds', Render.width, Render.height, bloomFormat);
    this.finalResult.createRT('bloom_final_result.dds', Render.width, Render.height, bloomFormat);
    this.bindGroup = null;
    this.combineBindGroup = null;
  }

  private updateBloomParams(): void {
    const params = new Float32Array([
      this.bloomIntensity,
      this.bloomThreshold,
      this.bloomKnee,
      this.bloomRadius,
    ]);
    GPUUtils.writeBuffer(this.uniformBuffer, 0, params);
  }

  public generateHighlights(
    gBufferBindGroup: GPUBindGroup,
    texture: GPUTextureView,
  ): GPUTextureView {
    this.setBindGroup(texture);

    // Use RenderPassManager to execute bloom filter pass dynamically
    this.renderPassManager.executeBloomFilteringPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.bindGroup!,
      this.result,
    );

    const highlightsResult = this.result.getView();

    // Apply multiscaling blur to the highlights
    const blurredHighlights = this.applyMultiscaleBlur(highlightsResult);

    return blurredHighlights;
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
      this.bloomParamsBindGroup!, // Bloom parameters bindgroup
    );

    // Execute the custom pass directly using RenderPassManager
    this.renderPassManager.executeDynamicPass(pass);

    // Return the combined result
    return this.finalResult.getView();
  }

  // Additional bind groups for bloom combine operation
  private bloomBindGroup!: GPUBindGroup;
  private bloomParamsBindGroup!: GPUBindGroup;

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

    // Create bind group for bloom parameters (group 3)
    this.bloomParamsBindGroup = BindGroupFactory.createBindGroup(
      `bloom_params_bindgroup`,
      this.combineTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    );
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

  // Bind groups are now set up in setupCombineBindGroups method

  // Getters for bloom parameters (for UI/debug)
  public getBloomIntensity(): number {
    return this.bloomIntensity;
  }
  public setBloomIntensity(value: number): void {
    this.bloomIntensity = value;
    this.updateBloomParams();
  }

  public getBloomThreshold(): number {
    return this.bloomThreshold;
  }
  public setBloomThreshold(value: number): void {
    this.bloomThreshold = value;
    this.updateBloomParams();
  }

  // Additional bloom parameter controls
  public getBloomRadius(): number {
    return this.bloomRadius;
  }
  public setBloomRadius(value: number): void {
    this.bloomRadius = Math.max(0.1, Math.min(5.0, value));
    this.updateBloomParams();
  }

  public getBloomKnee(): number {
    return this.bloomKnee;
  }
  public setBloomKnee(value: number): void {
    this.bloomKnee = Math.max(0.0, Math.min(1.0, value));
    this.updateBloomParams();
  }

  // Inherit blur parameter controls from parent
  public override setMaxBlurSteps(steps: number): void {
    super.setMaxBlurSteps(steps);
  }

  public override setBlurStrength(strength: number): void {
    super.setBlurStrength(strength);
  }

  public override setBlendIntensity(intensity: number): void {
    super.setBlendIntensity(intensity);
  }

  public override update(_dt: number): void {
    // Update bloom parameters if needed
  }

  public override debugInMenu(): void {
    // Implement debug menu for bloom parameters
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'render';
    const subfolderKey = 'Camera Components';
    const componentName = 'Bloom';

    // Add controls to the Camera Components subfolder
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Add controls for bloom parameters
    addControl(this, 'bloomIntensity', `${componentName} Intensity`, {
      min: 0.0,
      max: 5.0,
      step: 0.1,
    });
    addControl(this, 'bloomThreshold', `${componentName} Threshold`, {
      min: 0.0,
      max: 5.0,
      step: 0.1,
    });
    addControl(this, 'bloomKnee', `${componentName} Knee`, {
      min: 0.0,
      max: 1.0,
      step: 0.05,
    });
    addControl(this, 'bloomRadius', `${componentName} Radius`, {
      min: 0.5,
      max: 5.0,
      step: 0.1,
    });

    // Add controls for inherited blur parameters from BlurComponent using wrapper objects
    const self = this;
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

    const blendIntensityWrapper = {
      get blendIntensity() {
        return self.getBlendIntensity();
      },
      set blendIntensity(value) {
        self.setBlendIntensity(value);
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
    addControl(blendIntensityWrapper, 'blendIntensity', `${componentName} Blend Intensity`, {
      min: 0.0,
      max: 2.0,
      step: 0.05,
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
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
    }
  }
}
