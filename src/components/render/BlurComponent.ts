import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import {
  AdvancedBlurConfig,
  AdvancedBlurParameters,
  BlurPreset,
} from '../../renderer/core/config/AdvancedBlurConfig';

/**
 * Represents a single blur step in the multiscaling blur pyramid
 */
export class BlurStep {
  public renderTarget: RenderTarget;
  public tempRenderTarget: RenderTarget; // For ping-pong rendering
  public width: number;
  public height: number;
  public downsampleBindGroup: GPUBindGroup | null = null;
  public upsampleBindGroup: GPUBindGroup | null = null;

  constructor(name: string, width: number, height: number, format: GPUTextureFormat) {
    this.width = width;
    this.height = height;

    // Main render target
    this.renderTarget = new RenderTarget();
    this.renderTarget.createRT(
      `blur_step_${name}`,
      width,
      height,
      format,
      false,
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    );

    // Temporary render target for ping-pong
    this.tempRenderTarget = new RenderTarget();
    this.tempRenderTarget.createRT(
      `blur_step_${name}_temp`,
      width,
      height,
      format,
      false,
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    );
  }

  public createDownsampleBindGroup(
    inputTexture: GPUTextureView,
    sampler: GPUSampler,
    layout: GPUBindGroupLayout,
    uniformBuffer: GPUBuffer,
  ): void {
    this.downsampleBindGroup = BindGroupFactory.createBindGroup(
      `blur_step_downsample_${this.width}x${this.height}`,
      layout,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: this.renderTarget.getStorageView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    );
  }

  public createUpsampleBindGroup(
    inputTexture: GPUTextureView,
    higherResTexture: GPUTextureView,
    sampler: GPUSampler,
    layout: GPUBindGroupLayout,
    uniformBuffer: GPUBuffer,
  ): void {
    this.upsampleBindGroup = BindGroupFactory.createBindGroup(
      `blur_step_upsample_${this.width}x${this.height}`,
      layout,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: this.tempRenderTarget.getStorageView() }, // Write to temp
        { binding: 2, resource: sampler },
        { binding: 3, resource: higherResTexture },
        { binding: 4, resource: { buffer: uniformBuffer } },
      ],
    );
  }

  public dispose(): void {
    this.renderTarget.destroy();
    this.tempRenderTarget.destroy();
  }

  // Get the final result (after upsampling, use temp target)
  public getFinalView(): GPUTextureView {
    return this.tempRenderTarget.getView();
  }
}

/**
 * Modern blur component using compute shaders for multiscaling blur
 */
export class BlurComponent extends Component {
  protected steps: BlurStep[] = [];
  protected downsamplePipeline!: GPUComputePipeline;
  protected upsamplePipeline!: GPUComputePipeline;
  protected downsamplePipelineRGBA8!: GPUComputePipeline; // For low quality
  protected upsamplePipelineRGBA8!: GPUComputePipeline; // For low quality
  protected downsampleBindGroupLayout!: GPUBindGroupLayout;
  protected upsampleBindGroupLayout!: GPUBindGroupLayout;
  protected downsampleBindGroupLayoutRGBA8!: GPUBindGroupLayout; // For low quality
  protected upsampleBindGroupLayoutRGBA8!: GPUBindGroupLayout; // For low quality

  // Advanced blur pipelines for separable Gaussian blur
  protected advancedHorizontalPipeline!: GPUComputePipeline;
  protected advancedVerticalPipeline!: GPUComputePipeline;
  protected advancedBlurBindGroupLayout!: GPUBindGroupLayout;

  protected sampler!: GPUSampler;
  protected maxBlurSteps: number = 4;
  protected blurIntensity: number = 1.0;

  // Uniform buffers for blur parameters
  protected blurUniformBuffer!: GPUBuffer;
  protected blurStrength: number = 1.0;
  protected blendIntensity: number = 0.8;

  // Advanced blur configuration
  protected blurConfig: AdvancedBlurParameters;
  protected advancedBlurUniformBuffer!: GPUBuffer;

  constructor() {
    super();

    // Initialize advanced blur configuration based on quality settings
    const qualitySettings = QualitySettings.getInstance();
    const quality = qualitySettings.getSettings().postProcessingQuality;
    const preset = AdvancedBlurConfig.getQualityPreset(quality);
    this.blurConfig = AdvancedBlurConfig.getPreset(preset);
  }

  public async load(): Promise<void> {
    await this.createComputePipelines();
    await this.createAdvancedBlurPipelines();
    this.createUniformBuffers();
    this.createAdvancedBlurUniformBuffer();

    // Create sampler for texture sampling
    this.sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.createBlurSteps();
    this.updateAdvancedBlurParams();
  }

  private async createComputePipelines(): Promise<void> {
    const device = Render.getInstance().getDevice();

    // Load shaders for both RGBA16 and RGBA8 formats
    const downsampleShaderCode = await fetch('/assets/shaders/bloom_downsample_blur.cs').then((r) =>
      r.text(),
    );
    const upsampleShaderCode = await fetch('/assets/shaders/bloom_upsample_blend.cs').then((r) =>
      r.text(),
    );
    const downsampleShaderCodeRGBA8 = await fetch(
      '/assets/shaders/bloom_downsample_blur_rgba8.cs',
    ).then((r) => r.text());
    const upsampleShaderCodeRGBA8 = await fetch(
      '/assets/shaders/bloom_upsample_blend_rgba8.cs',
    ).then((r) => r.text());

    // Create bind group layouts for RGBA16Float
    this.createBindGroupLayouts(device, 'rgba16float');

    // Create bind group layouts for RGBA8Unorm
    this.createBindGroupLayoutsRGBA8(device);

    // Create pipeline layouts
    const downsamplePipelineLayout = device.createPipelineLayout({
      label: 'Downsample Blur Pipeline Layout',
      bindGroupLayouts: [this.downsampleBindGroupLayout],
    });

    const upsamplePipelineLayout = device.createPipelineLayout({
      label: 'Upsample Blur Pipeline Layout',
      bindGroupLayouts: [this.upsampleBindGroupLayout],
    });

    const downsamplePipelineLayoutRGBA8 = device.createPipelineLayout({
      label: 'Downsample Blur Pipeline Layout RGBA8',
      bindGroupLayouts: [this.downsampleBindGroupLayoutRGBA8],
    });

    const upsamplePipelineLayoutRGBA8 = device.createPipelineLayout({
      label: 'Upsample Blur Pipeline Layout RGBA8',
      bindGroupLayouts: [this.upsampleBindGroupLayoutRGBA8],
    });

    // Create RGBA16Float pipelines
    const downsampleShader = device.createShaderModule({
      label: 'Downsample Blur Compute Shader',
      code: downsampleShaderCode,
    });

    this.downsamplePipeline = device.createComputePipeline({
      label: 'Downsample Blur Pipeline',
      layout: downsamplePipelineLayout,
      compute: {
        module: downsampleShader,
        entryPoint: 'CS_downsample_blur',
      },
    });

    const upsampleShader = device.createShaderModule({
      label: 'Upsample Blend Compute Shader',
      code: upsampleShaderCode,
    });

    this.upsamplePipeline = device.createComputePipeline({
      label: 'Upsample Blend Pipeline',
      layout: upsamplePipelineLayout,
      compute: {
        module: upsampleShader,
        entryPoint: 'CS_upsample_blend',
      },
    });

    // Create RGBA8Unorm pipelines
    const downsampleShaderRGBA8 = device.createShaderModule({
      label: 'Downsample Blur Compute Shader RGBA8',
      code: downsampleShaderCodeRGBA8,
    });

    this.downsamplePipelineRGBA8 = device.createComputePipeline({
      label: 'Downsample Blur Pipeline RGBA8',
      layout: downsamplePipelineLayoutRGBA8,
      compute: {
        module: downsampleShaderRGBA8,
        entryPoint: 'CS_downsample_blur',
      },
    });

    const upsampleShaderRGBA8 = device.createShaderModule({
      label: 'Upsample Blend Compute Shader RGBA8',
      code: upsampleShaderCodeRGBA8,
    });

    this.upsamplePipelineRGBA8 = device.createComputePipeline({
      label: 'Upsample Blend Pipeline RGBA8',
      layout: upsamplePipelineLayoutRGBA8,
      compute: {
        module: upsampleShaderRGBA8,
        entryPoint: 'CS_upsample_blend',
      },
    });
  }

  private async createAdvancedBlurPipelines(): Promise<void> {
    const device = Render.getInstance().getDevice();

    // Load advanced blur shaders
    const horizontalShaderCode = await fetch('/assets/shaders/advanced_blur_horizontal.cs').then(
      (r) => r.text(),
    );
    const verticalShaderCode = await fetch('/assets/shaders/advanced_blur_vertical.cs').then((r) =>
      r.text(),
    );

    // Create bind group layout for advanced blur
    this.advancedBlurBindGroupLayout = device.createBindGroupLayout({
      label: 'Advanced Blur Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float', // Dynamic format based on quality
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create pipeline layouts
    const pipelineLayout = device.createPipelineLayout({
      label: 'Advanced Blur Pipeline Layout',
      bindGroupLayouts: [this.advancedBlurBindGroupLayout],
    });

    // Create shader modules
    const horizontalShader = device.createShaderModule({
      label: 'Advanced Horizontal Blur Compute Shader',
      code: horizontalShaderCode,
    });

    const verticalShader = device.createShaderModule({
      label: 'Advanced Vertical Blur Compute Shader',
      code: verticalShaderCode,
    });

    // Create compute pipelines
    this.advancedHorizontalPipeline = device.createComputePipeline({
      label: 'Advanced Horizontal Blur Pipeline',
      layout: pipelineLayout,
      compute: {
        module: horizontalShader,
        entryPoint: 'CS_advanced_blur',
      },
    });

    this.advancedVerticalPipeline = device.createComputePipeline({
      label: 'Advanced Vertical Blur Pipeline',
      layout: pipelineLayout,
      compute: {
        module: verticalShader,
        entryPoint: 'CS_advanced_blur_vertical',
      },
    });
  }

  private createAdvancedBlurUniformBuffer(): void {
    // Buffer layout: weights(vec4) + distanceFactors(vec4) + globalDistance(f32) + padding(3*f32)
    // Total: 48 bytes for proper alignment

    this.advancedBlurUniformBuffer = GPUUtils.createBuffer(
      'advanced_blur_uniforms',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  private updateAdvancedBlurParams(): void {
    // Normalize weights and create uniform data
    const normalizedWeights = AdvancedBlurConfig.normalizeWeights(this.blurConfig.weights);
    const distanceFactors = AdvancedBlurConfig.getDistanceFactorsArray(
      this.blurConfig.distanceFactors,
    );

    // Create the uniform buffer data
    const uniformData = new Float32Array(12); // 48 bytes / 4 = 12 floats

    // Copy weights (vec4)
    uniformData.set(normalizedWeights, 0);

    // Copy distance factors (vec4)
    uniformData.set(distanceFactors, 4);

    // Set global distance (f32)
    uniformData[8] = this.blurConfig.globalDistance;

    // Padding (3 floats) - already zero-initialized

    GPUUtils.writeBuffer(this.advancedBlurUniformBuffer, 0, uniformData);
  }

  /**
   * Apply preset configuration for advanced blur
   */
  public applyBlurPreset(preset: BlurPreset): void {
    this.blurConfig = AdvancedBlurConfig.getPreset(preset);
    this.updateAdvancedBlurParams();
  }

  /**
   * Update specific blur parameters
   */
  public updateBlurConfig(config: Partial<AdvancedBlurParameters>): void {
    this.blurConfig = { ...this.blurConfig, ...config };
    this.updateAdvancedBlurParams();
  }

  /**
   * Get current blur configuration
   */
  public getBlurConfig(): AdvancedBlurParameters {
    return { ...this.blurConfig };
  }

  private createUniformBuffers(): void {
    const device = Render.getInstance().getDevice();

    // Create uniform buffer for blur parameters (4 floats = 16 bytes)
    this.blurUniformBuffer = device.createBuffer({
      label: 'Blur Uniforms Buffer',
      size: 16, // 4 floats * 4 bytes each
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.updateUniformBuffers();
  }

  private updateUniformBuffers(): void {
    const device = Render.getInstance().getDevice();
    const uniformData = new Float32Array([
      this.blurStrength,
      this.blendIntensity,
      0.0, // padding
      0.0, // padding
    ]);

    device.queue.writeBuffer(this.blurUniformBuffer, 0, uniformData);
  }

  private createBindGroupLayouts(device: GPUDevice, format: GPUTextureFormat): void {
    // Create downsampling bind group layout (4 bindings)
    this.downsampleBindGroupLayout = device.createBindGroupLayout({
      label: 'Downsample Blur Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: format,
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create upsampling bind group layout (5 bindings)
    this.upsampleBindGroupLayout = device.createBindGroupLayout({
      label: 'Upsample Blur Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: format,
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });
  }

  private createBindGroupLayoutsRGBA8(device: GPUDevice): void {
    // Create downsampling bind group layout for RGBA8 (4 bindings)
    this.downsampleBindGroupLayoutRGBA8 = device.createBindGroupLayout({
      label: 'Downsample Blur Bind Group Layout RGBA8',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create upsampling bind group layout for RGBA8 (5 bindings)
    this.upsampleBindGroupLayoutRGBA8 = device.createBindGroupLayout({
      label: 'Upsample Blur Bind Group Layout RGBA8',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });
  }

  public async recreatePipelinesForFormat(): Promise<void> {
    // This method should be called when quality settings change
    await this.createComputePipelines();
    console.log('Bloom pipelines recreated for new texture format');
  }

  private createBlurSteps(): void {
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    // Clear existing steps
    this.steps.forEach((step) => step.dispose());
    this.steps = [];

    // Create blur steps with progressively smaller resolutions
    let width = Render.width;
    let height = Render.height;

    for (let i = 0; i < this.maxBlurSteps; i++) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));

      const step = new BlurStep(`step_${i}`, width, height, bloomFormat);
      this.steps.push(step);
    }
  }

  public update(_deltaTime: number): void {
    // Component update logic if needed
  }

  public renderDebug(): void {
    // Debug rendering if needed
  }

  public dispose(): void {
    this.steps.forEach((step) => step.dispose());
    this.blurUniformBuffer?.destroy();
    this.advancedBlurUniformBuffer?.destroy();
  }

  /**
   * Set maximum number of blur steps
   */
  public setMaxBlurSteps(steps: number): void {
    this.maxBlurSteps = Math.max(1, Math.min(8, steps));
    // Recreate blur steps with new count
    this.createBlurSteps();
  }

  /**
   * Set blur strength parameter
   */
  public setBlurStrength(strength: number): void {
    this.blurStrength = Math.max(0.1, Math.min(5.0, strength));
    this.updateUniformBuffers();
  }

  /**
   * Set blend intensity parameter
   */
  public setBlendIntensity(intensity: number): void {
    this.blendIntensity = Math.max(0.0, Math.min(2.0, intensity));
    this.updateUniformBuffers();
  }

  /**
   * Get current blur strength
   */
  public getBlurStrength(): number {
    return this.blurStrength;
  }

  /**
   * Get current blend intensity
   */
  public getBlendIntensity(): number {
    return this.blendIntensity;
  }

  /**
   * Get current max blur steps
   */
  public getMaxBlurSteps(): number {
    return this.maxBlurSteps;
  }

  /**
   * Resize blur component when screen resolution changes
   */
  public resize(): void {
    // Recreate blur steps with new screen resolution
    this.createBlurSteps();
  }

  /**
   * Apply blur to a single step using downsample/upsample pipelines
   */
  protected applyBlurStep(
    inputTexture: GPUTextureView,
    step: BlurStep,
    stepIndex: number,
  ): GPUTextureView {
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: `Blur Step ${stepIndex} Command Encoder`,
    });

    // Determine which pipeline to use based on quality settings
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;
    const isHighQuality = bloomFormat === 'rgba16float';

    // Choose appropriate pipelines and layouts
    const downsamplePipeline = isHighQuality
      ? this.downsamplePipeline
      : this.downsamplePipelineRGBA8;
    const downsampleLayout = isHighQuality
      ? this.downsampleBindGroupLayout
      : this.downsampleBindGroupLayoutRGBA8;

    // Create downsample bind group for this step
    step.createDownsampleBindGroup(
      inputTexture,
      this.sampler,
      downsampleLayout,
      this.blurUniformBuffer,
    );

    // Dispatch downsample pass
    if (step.downsampleBindGroup) {
      const computePass = commandEncoder.beginComputePass({
        label: `Downsample Blur Pass Step ${stepIndex}`,
      });

      computePass.setPipeline(downsamplePipeline);
      computePass.setBindGroup(0, step.downsampleBindGroup);

      // Calculate dispatch size
      const workgroupSize = 16; // From shader WORKGROUP_SIZE
      const dispatchX = Math.ceil(step.width / workgroupSize);
      const dispatchY = Math.ceil(step.height / workgroupSize);

      computePass.dispatchWorkgroups(dispatchX, dispatchY);
      computePass.end();
    }

    // Submit the command buffer
    device.queue.submit([commandEncoder.finish()]);

    // Return the downsampled result
    return step.renderTarget.getView();
  }

  /**
   * Apply multiscale blur with proper upsample passes
   */
  public applyMultiscaleBlur(inputTexture: GPUTextureView): GPUTextureView {
    if (this.steps.length === 0) return inputTexture;

    // Downsample pass - blur each step progressively
    let currentTexture = inputTexture;
    const activeSteps = Math.min(this.blurConfig.activeSteps, this.steps.length);

    // Downsample phase
    for (let i = 0; i < activeSteps; i++) {
      const step = this.steps[i];
      if (step) {
        currentTexture = this.applyBlurStep(currentTexture, step, i);
      }
    }

    // Upsample phase - blend back up to original resolution
    for (let i = activeSteps - 2; i >= 0; i--) {
      const step = this.steps[i];
      const higherResStep = i === 0 ? null : this.steps[i - 1] || null;

      if (step) {
        currentTexture = this.applyUpsampleStep(currentTexture, step, higherResStep, i);
      }
    }

    return currentTexture;
  }

  /**
   * Apply upsample step with blending
   */
  protected applyUpsampleStep(
    inputTexture: GPUTextureView,
    step: BlurStep,
    higherResStep: BlurStep | null,
    stepIndex: number,
  ): GPUTextureView {
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: `Upsample Step ${stepIndex} Command Encoder`,
    });

    // Determine which pipeline to use based on quality settings
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;
    const isHighQuality = bloomFormat === 'rgba16float';

    // Choose appropriate pipelines and layouts
    const upsamplePipeline = isHighQuality ? this.upsamplePipeline : this.upsamplePipelineRGBA8;
    const upsampleLayout = isHighQuality
      ? this.upsampleBindGroupLayout
      : this.upsampleBindGroupLayoutRGBA8;

    // Use original input texture if no higher resolution step available
    const higherResTexture = higherResStep ? higherResStep.renderTarget.getView() : inputTexture;

    // Create upsample bind group for this step
    step.createUpsampleBindGroup(
      inputTexture,
      higherResTexture,
      this.sampler,
      upsampleLayout,
      this.blurUniformBuffer,
    );

    // Dispatch upsample pass
    if (step.upsampleBindGroup) {
      const computePass = commandEncoder.beginComputePass({
        label: `Upsample Blur Pass Step ${stepIndex}`,
      });

      computePass.setPipeline(upsamplePipeline);
      computePass.setBindGroup(0, step.upsampleBindGroup);

      // Calculate dispatch size for higher resolution
      const workgroupSize = 16;
      const targetWidth = higherResStep ? higherResStep.width : Render.width;
      const targetHeight = higherResStep ? higherResStep.height : Render.height;
      const dispatchX = Math.ceil(targetWidth / workgroupSize);
      const dispatchY = Math.ceil(targetHeight / workgroupSize);

      computePass.dispatchWorkgroups(dispatchX, dispatchY);
      computePass.end();
    }

    // Submit the command buffer
    device.queue.submit([commandEncoder.finish()]);

    // Return the upsampled result (from temp target)
    return step.getFinalView();
  }

  /**
   * Debug menu for blur parameters
   */
  public debugInMenu(): void {
    // Debug interface for blur parameters
    console.log('Blur Config:', this.blurConfig);
    console.log('Max Steps:', this.maxBlurSteps);
    console.log('Blur Strength:', this.blurStrength);
    console.log('Blend Intensity:', this.blendIntensity);
  }

  /**
   * Apply advanced Gaussian blur using separable horizontal/vertical passes
   */
  public applyAdvancedBlur(inputTexture: GPUTextureView): GPUTextureView {
    if (this.steps.length === 0) return inputTexture;

    let currentTexture = inputTexture;

    // Apply advanced blur to each step with separable passes
    for (let i = 0; i < Math.min(this.blurConfig.activeSteps, this.steps.length); i++) {
      const step = this.steps[i];
      if (step) {
        // Apply horizontal blur pass
        currentTexture = this.applyAdvancedHorizontalBlur(currentTexture, step, i);
        // Apply vertical blur pass using result of horizontal pass
        currentTexture = this.applyAdvancedVerticalBlur(currentTexture, step, i);
      }
    }

    return currentTexture;
  }

  /**
   * Apply advanced horizontal blur pass
   */
  protected applyAdvancedHorizontalBlur(
    inputTexture: GPUTextureView,
    step: BlurStep,
    stepIndex: number,
  ): GPUTextureView {
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: `Advanced Horizontal Blur Step ${stepIndex} Command Encoder`,
    });

    // Create bind group for advanced horizontal blur
    const bindGroup = BindGroupFactory.createBindGroup(
      `advanced_horizontal_blur_step_${stepIndex}`,
      this.advancedBlurBindGroupLayout,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: step.renderTarget.getStorageView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.advancedBlurUniformBuffer } },
      ],
    );

    // Dispatch horizontal blur compute pass
    const computePass = commandEncoder.beginComputePass({
      label: `Advanced Horizontal Blur Pass Step ${stepIndex}`,
    });

    computePass.setPipeline(this.advancedHorizontalPipeline);
    computePass.setBindGroup(0, bindGroup);

    // Calculate dispatch size
    const workgroupSize = 16; // From shader WORKGROUP_SIZE
    const dispatchX = Math.ceil(step.width / workgroupSize);
    const dispatchY = Math.ceil(step.height / workgroupSize);

    computePass.dispatchWorkgroups(dispatchX, dispatchY);
    computePass.end();

    // Submit the command buffer
    device.queue.submit([commandEncoder.finish()]);

    return step.renderTarget.getView();
  }

  /**
   * Apply advanced vertical blur pass
   */
  protected applyAdvancedVerticalBlur(
    inputTexture: GPUTextureView,
    step: BlurStep,
    stepIndex: number,
  ): GPUTextureView {
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: `Advanced Vertical Blur Step ${stepIndex} Command Encoder`,
    });

    // Create bind group for advanced vertical blur (write to temp render target)
    const bindGroup = BindGroupFactory.createBindGroup(
      `advanced_vertical_blur_step_${stepIndex}`,
      this.advancedBlurBindGroupLayout,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: step.tempRenderTarget.getStorageView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.advancedBlurUniformBuffer } },
      ],
    );

    // Dispatch vertical blur compute pass
    const computePass = commandEncoder.beginComputePass({
      label: `Advanced Vertical Blur Pass Step ${stepIndex}`,
    });

    computePass.setPipeline(this.advancedVerticalPipeline);
    computePass.setBindGroup(0, bindGroup);

    // Calculate dispatch size
    const workgroupSize = 16; // From shader WORKGROUP_SIZE
    const dispatchX = Math.ceil(step.width / workgroupSize);
    const dispatchY = Math.ceil(step.height / workgroupSize);

    computePass.dispatchWorkgroups(dispatchX, dispatchY);
    computePass.end();

    // Submit the command buffer
    device.queue.submit([commandEncoder.finish()]);

    return step.tempRenderTarget.getView();
  }

  /**
   * Switch between standard and advanced blur methods
   */
  public applyBlur(inputTexture: GPUTextureView, useAdvancedBlur: boolean = false): GPUTextureView {
    if (useAdvancedBlur) {
      return this.applyAdvancedBlur(inputTexture);
    } else {
      return this.applyMultiscaleBlur(inputTexture);
    }
  }
}
