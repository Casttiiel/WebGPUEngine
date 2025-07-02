import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';

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
  protected downsampleBindGroupLayout!: GPUBindGroupLayout;
  protected upsampleBindGroupLayout!: GPUBindGroupLayout;
  protected sampler!: GPUSampler;
  protected maxBlurSteps: number = 4;
  protected blurIntensity: number = 1.0;

  // Uniform buffers for blur parameters
  protected blurUniformBuffer!: GPUBuffer;
  protected blurStrength: number = 1.0;
  protected blendIntensity: number = 0.8;

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    await this.createComputePipelines();
    this.createUniformBuffers();

    // Create sampler for texture sampling
    this.sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.createBlurSteps();
  }

  private async createComputePipelines(): Promise<void> {
    const device = Render.getInstance().getDevice();

    // Load shaders
    const downsampleShaderCode = await fetch('/assets/shaders/bloom_downsample_blur.cs').then((r) =>
      r.text(),
    );
    const upsampleShaderCode = await fetch('/assets/shaders/bloom_upsample_blend.cs').then((r) =>
      r.text(),
    );

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
            format: 'rgba16float',
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
            format: 'rgba16float',
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

    // Create pipeline layouts
    const downsamplePipelineLayout = device.createPipelineLayout({
      label: 'Downsample Blur Pipeline Layout',
      bindGroupLayouts: [this.downsampleBindGroupLayout],
    });

    const upsamplePipelineLayout = device.createPipelineLayout({
      label: 'Upsample Blur Pipeline Layout',
      bindGroupLayouts: [this.upsampleBindGroupLayout],
    });

    // Create downsample pipeline
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

    // Create upsample pipeline
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
  }

  protected createBlurSteps(): void {
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    let width = Render.width;
    let height = Render.height;

    // Create downsampling steps (pyramid down)
    for (let i = 0; i < this.maxBlurSteps; i++) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));

      const step = new BlurStep(`down_${i}`, width, height, bloomFormat);
      this.steps.push(step);

      // Stop if texture becomes too small
      if (width <= 4 || height <= 4) break;
    }
  }

  /**
   * Public parameter control methods
   */
  public setMaxBlurSteps(steps: number): void {
    if (steps !== this.maxBlurSteps) {
      this.maxBlurSteps = Math.max(1, Math.min(8, steps)); // Clamp between 1-8 steps
      this.resize(); // Recreate blur steps with new count
    }
  }

  public getMaxBlurSteps(): number {
    return this.maxBlurSteps;
  }

  public setBlurStrength(strength: number): void {
    this.blurStrength = Math.max(0.1, Math.min(5.0, strength)); // Clamp between 0.1-5.0
    this.updateUniformBuffers();
  }

  public getBlurStrength(): number {
    return this.blurStrength;
  }

  public setBlendIntensity(intensity: number): void {
    this.blendIntensity = Math.max(0.0, Math.min(2.0, intensity)); // Clamp between 0.0-2.0
    this.updateUniformBuffers();
  }

  public getBlendIntensity(): number {
    return this.blendIntensity;
  }

  public resize(): void {
    // Clear existing steps
    for (const step of this.steps) {
      step.dispose();
    }
    this.steps = [];

    // Recreate blur steps with new resolution
    this.createBlurSteps();
  }

  /**
   * Apply multiscaling blur using compute shaders
   */
  public applyMultiscaleBlur(inputTexture: GPUTextureView): GPUTextureView {
    const render = Render.getInstance();
    const commandEncoder = render.getCommandEncoder();

    // Downsampling pass - create blur pyramid
    let currentInput = inputTexture;
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;

      // Create bind group for downsampling
      step.createDownsampleBindGroup(
        currentInput,
        this.sampler,
        this.downsampleBindGroupLayout,
        this.blurUniformBuffer,
      );

      // Execute compute pass for downsampling and blur
      const computePass = commandEncoder.beginComputePass({
        label: `Bloom Downsample Step ${i}`,
      });

      computePass.setPipeline(this.downsamplePipeline);
      computePass.setBindGroup(0, step.downsampleBindGroup!);

      const workgroupsX = Math.ceil(step.width / 16);
      const workgroupsY = Math.ceil(step.height / 16);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);

      computePass.end();

      // Clear bind group to avoid stale references
      step.downsampleBindGroup = null;

      // Use this step's output as next step's input
      currentInput = step.renderTarget.getView();
    }

    // Upsampling pass - blend back up the pyramid
    for (let i = this.steps.length - 2; i >= 0; i--) {
      const currentStep = this.steps[i]!;
      const lowerResStep = this.steps[i + 1]!;

      // For upsampling, read from lower res step and current step, write to current step's temp
      const inputFromLowerRes = lowerResStep.renderTarget.getView();
      const currentStepRead = currentStep.renderTarget.getView();

      // Create bind group for upsampling with additive blending
      currentStep.createUpsampleBindGroup(
        inputFromLowerRes,
        currentStepRead,
        this.sampler,
        this.upsampleBindGroupLayout,
        this.blurUniformBuffer,
      );

      // Execute compute pass for upsampling and blending
      const computePass = commandEncoder.beginComputePass({
        label: `Bloom Upsample Step ${i}`,
      });

      computePass.setPipeline(this.upsamplePipeline);
      computePass.setBindGroup(0, currentStep.upsampleBindGroup!);

      const workgroupsX = Math.ceil(currentStep.width / 16);
      const workgroupsY = Math.ceil(currentStep.height / 16);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);

      computePass.end();

      // Clear bind groups to avoid stale references
      currentStep.upsampleBindGroup = null;
    }

    // Return the final blurred result (first step's temp target contains the full-resolution blur)
    return this.steps.length > 0 ? this.steps[0]!.getFinalView() : inputTexture;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    return this.applyMultiscaleBlur(texture);
  }

  public update(_dt: number): void {
    // Update blur parameters if needed
  }

  public debugInMenu(): void {
    // Implement debug menu for blur parameters
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public dispose(): void {
    for (const step of this.steps) {
      step.dispose();
    }
    this.steps = [];

    if (this.blurUniformBuffer) {
      this.blurUniformBuffer.destroy();
    }
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
}
