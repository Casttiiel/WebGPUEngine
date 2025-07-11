import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import {
  AdvancedBlurConfig,
  AdvancedBlurParameters,
} from '../../renderer/core/config/AdvancedBlurConfig';

/**
 * Represents a single blur step in the multiscaling blur pyramid
 */
export class BlurStep {
  public renderTarget: RenderTarget;
  public tempRenderTarget: RenderTarget; // For ping-pong rendering
  public width: number;
  public height: number;

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

  public dispose(): void {
    this.renderTarget.destroy();
    this.tempRenderTarget.destroy();
  }
}

/**
 * Modern blur component using separable Gaussian blur
 */
export class BlurComponent extends Component {
  protected steps: BlurStep[] = [];
  protected advancedHorizontalPipeline!: GPUComputePipeline;
  protected advancedVerticalPipeline!: GPUComputePipeline;
  protected advancedBlurBindGroupLayout!: GPUBindGroupLayout;

  protected sampler!: GPUSampler;
  protected maxBlurSteps: number = 4;

  // Uniform buffers for blur parameters
  protected blurStrength: number = 1.0;
  protected blendIntensity: number = 0.8;

  // Advanced blur configuration
  protected blurConfig: AdvancedBlurParameters;
  protected advancedBlurUniformBuffer!: GPUBuffer;

  // Gaussian blur properties
  private gaussianBlurUniformBuffer!: GPUBuffer;
  private blurTargetA!: RenderTarget;
  private blurTargetB!: RenderTarget;
  private globalDistance: number = 1.0;

  // Default weights from blur.fx - well balanced for most situations
  private weights = {
    center: 0.2508, // w0 - center weight
    first: 0.2004, // w1 - first pair weight
    second: 0.124, // w2 - second pair weight
    third: 0.0539, // w3 - third pair weight
  };

  // Default offsets from blur.fx - based on optimal sampling pattern
  private distances = {
    first: 1.407, // d1 - first sample distance
    second: 3.294, // d2 - second sample distance
    third: 5.181, // d3 - third sample distance
  };

  constructor() {
    super();

    // Initialize advanced blur configuration based on quality settings
    const qualitySettings = QualitySettings.getInstance();
    const quality = qualitySettings.getSettings().postProcessingQuality;
    const preset = AdvancedBlurConfig.getQualityPreset(quality);
    this.blurConfig = AdvancedBlurConfig.getPreset(preset);
  }

  public async load(): Promise<void> {
    await this.createAdvancedBlurPipelines();
    this.createAdvancedBlurUniformBuffer();

    // Create uniform buffer for Gaussian blur parameters
    this.gaussianBlurUniformBuffer = GPUUtils.createBuffer(
      'gaussian_blur_uniforms',
      64, // 16 floats * 4 bytes (weights, distances, direction, globalDistance)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create blur render targets for ping-pong
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    this.blurTargetA = new RenderTarget();
    this.blurTargetA.createRT('blur_target_a.dds', Render.width, Render.height, bloomFormat);

    this.blurTargetB = new RenderTarget();
    this.blurTargetB.createRT('blur_target_b.dds', Render.width, Render.height, bloomFormat);

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
    this.updateGaussianBlurParams();
  }

  private updateGaussianBlurParams(): void {
    // Update Gaussian blur parameters buffer
    const uniformData = new Float32Array([
      this.weights.center,
      this.weights.first,
      this.weights.second,
      this.weights.third,
      this.distances.first,
      this.distances.second,
      this.distances.third,
      this.globalDistance,
      0.0,
      0.0, // direction will be set per pass
      0.0,
      0.0,
      0.0,
      0.0,
      0.0,
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.gaussianBlurUniformBuffer, 0, uniformData);
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
    this.advancedBlurUniformBuffer?.destroy();

    // Dispose Gaussian blur resources
    this.gaussianBlurUniformBuffer?.destroy();
    this.blurTargetA?.destroy();
    this.blurTargetB?.destroy();
  }

  // Gaussian blur parameter setters

  /**
   * Set the global blur distance (affects both horizontal and vertical passes)
   * @param distance The global distance multiplier
   */
  public setGaussianBlurDistance(distance: number): void {
    this.globalDistance = distance;
    this.updateGaussianBlurParams();
  }

  public getBlurStrength(): number {
    return this.globalDistance;
  }

  public getBlendIntensity(): number {
    return this.blendIntensity;
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
   * Set blur strength parameter (now controls Gaussian blur global distance)
   */
  public setBlurStrength(strength: number): void {
    this.blurStrength = Math.max(0.1, Math.min(5.0, strength));
    this.setGaussianBlurDistance(this.blurStrength);
  }

  /**
   * Set blend intensity parameter
   */
  public setBlendIntensity(intensity: number): void {
    this.blendIntensity = Math.max(0.0, Math.min(2.0, intensity));
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
    // Dispose of any existing blur steps
    this.steps.forEach((step) => step.dispose());
    this.steps = [];

    // Recreate blur steps with new screen resolution
    this.createBlurSteps();

    // Recreate Gaussian blur targets with new resolution
    if (this.blurTargetA && this.blurTargetB) {
      const qualitySettings = QualitySettings.getInstance();
      const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

      // Use screen resolution for the blur targets
      const targetWidth = Render.width;
      const targetHeight = Render.height;

      this.blurTargetA.createRT('blur_target_a.dds', targetWidth, targetHeight, bloomFormat);
      this.blurTargetB.createRT('blur_target_b.dds', targetWidth, targetHeight, bloomFormat);

      console.log(`Resized Gaussian blur targets to ${targetWidth}x${targetHeight}`);
    }
  }

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

  public applyBlur(inputTexture: GPUTextureView): GPUTextureView {
    return this.applyAdvancedBlur(inputTexture);
  }
}
