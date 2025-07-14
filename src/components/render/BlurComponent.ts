import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Technique } from '../../renderer/resources/Technique';
import { Mesh } from '../../renderer/resources/Mesh';

export class BlurStep {
  public halfYTarget: RenderTarget; // Horizontal blur result (xres x yres/2)
  public outputTarget: RenderTarget; // Final result (xres/2 x yres/2)
  public inputWidth: number;
  public inputHeight: number;

  constructor(name: string, inputWidth: number, inputHeight: number, format: GPUTextureFormat) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;

    // Horizontal blur target (same width, half height)
    this.halfYTarget = new RenderTarget();
    this.halfYTarget.createRT(
      `blur_step_${name}_y`,
      this.inputWidth,
      Math.max(1, Math.floor(this.inputHeight / 2)),
      format,
      false,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );

    // Final output target (half width, half height)
    this.outputTarget = new RenderTarget();
    this.outputTarget.createRT(
      `blur_step_${name}_xy`,
      Math.max(1, Math.floor(this.inputWidth / 2)),
      Math.max(1, Math.floor(this.inputHeight / 2)),
      format,
      false,
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );
  }

  public dispose(): void {
    this.halfYTarget.destroy();
    this.outputTarget.destroy();
  }

  /**
   * Get the final output texture view for this step
   */
  public getOutputView(): GPUTextureView {
    return this.outputTarget.getView();
  }
}

export class BlurComponent extends Component {
  protected steps: BlurStep[] = [];
  protected sampler!: GPUSampler;
  protected maxBlurSteps: number = 4;

  // Gaussian blur properties following C++ blur.fx pattern
  private gaussianBlurTechnique!: Technique;
  private gaussianBlurUniformBuffer!: GPUBuffer;
  protected fullscreenQuadMesh!: Mesh;
  private globalDistance: number = 2.0;

  // Default weights from blur.fx - well balanced for most situations
  private normalizationFactor = 70 + 2 * 56 + 2 * 28 + 2 * 8;
  private blur_w = {
    center: 70 / this.normalizationFactor,
    first: 56 / this.normalizationFactor,
    second: 28 / this.normalizationFactor,
    third: 8 / this.normalizationFactor,
  };

  // Default offsets from blur.fx - based on optimal sampling pattern
  private blur_d = {
    first: 1,
    second: 2,
    third: 3,
  };

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    // Load Gaussian blur technique and mesh
    this.gaussianBlurTechnique = await Technique.get('gaussian_blur.tech');
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    // Create uniform buffer for Gaussian blur parameters
    this.gaussianBlurUniformBuffer = GPUUtils.createBuffer(
      'gaussian_blur_uniforms',
      64,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create sampler for texture sampling
    this.sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.createBlurSteps();
    this.updateGaussianBlurParams();
  }

  private updateGaussianBlurParams(): void {
    // Update Gaussian blur parameters buffer
    const uniformData = new Float32Array([
      this.blur_w.center,
      this.blur_w.first,
      this.blur_w.second,
      this.blur_w.third,
      this.blur_d.first,
      this.blur_d.second,
      this.blur_d.third,
      this.globalDistance,
      0.0,
      0.0, // direction will be set per pass
      0.0,
      0.0,
    ]);

    GPUUtils.writeBuffer(this.gaussianBlurUniformBuffer, 0, uniformData);
  }

  private createBlurSteps(): void {
    const qualitySettings = QualitySettings.getInstance();
    const bloomFormat = qualitySettings.getPostProcessingFormats().bloomTexture;

    // Clear existing steps
    this.steps.forEach((step) => step.dispose());
    this.steps = [];

    // Create blur steps with progressively smaller input resolutions
    // Each step takes input at one resolution and outputs at half resolution
    let inputWidth = Render.width / 2;
    let inputHeight = Render.height / 2;

    for (let i = 0; i < this.maxBlurSteps; i++) {
      const step = new BlurStep(`step_${i}`, inputWidth, inputHeight, bloomFormat);
      this.steps.push(step);

      // Next step takes the output of this step as input
      inputWidth = Math.max(1, Math.floor(inputWidth / 2));
      inputHeight = Math.max(1, Math.floor(inputHeight / 2));
    }
  }

  public applyBlur(inputTexture: GPUTextureView): GPUTextureView {
    if (this.steps.length === 0) return inputTexture;

    let currentInput = inputTexture;

    // Apply blur to each step sequentially, using output of previous step as input
    for (let i = 0; i < this.maxBlurSteps && i < this.steps.length; i++) {
      const step = this.steps[i];
      if (!step) continue;

      // Step 1: Apply horizontal blur (input -> halfYTarget)
      this.updateGaussianBlurDirection(0.0, this.globalDistance / step.inputHeight);
      this.applyGaussianBlurVertical(currentInput, step.halfYTarget);

      this.updateGaussianBlurDirection(this.globalDistance / step.inputWidth, 0.0);
      // Step 2: Apply vertical blur (halfYTarget -> outputTarget)
      this.applyGaussianBlurHorizontal(step.halfYTarget.getView(), step.outputTarget);

      // Use the output of this step as input for the next step
      currentInput = step.getOutputView();
    }

    return currentInput;
  }

  private applyGaussianBlurHorizontal(
    inputTexture: GPUTextureView,
    outputTarget: RenderTarget,
  ): void {
    // Simple render pass without complex bind group management
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: 'Gaussian Blur Horizontal',
    });

    const renderPass = commandEncoder.beginRenderPass({
      label: 'Gaussian Blur Horizontal Pass',
      colorAttachments: [
        {
          view: outputTarget.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    // Set technique and render pipeline
    const pipeline = this.gaussianBlurTechnique.getPipeline();
    renderPass.setPipeline(pipeline);

    // Bind texture and uniform resources
    const textureBindGroup = BindGroupFactory.createBindGroup(
      'gaussian_blur_h_texture',
      this.gaussianBlurTechnique.getBindGroupLayout(0)!,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: this.sampler },
      ],
    );

    const uniformBindGroup = BindGroupFactory.createBindGroup(
      'gaussian_blur_h_uniform',
      this.gaussianBlurTechnique.getBindGroupLayout(1)!,
      [{ binding: 0, resource: { buffer: this.gaussianBlurUniformBuffer } }],
    );

    renderPass.setBindGroup(0, textureBindGroup);
    renderPass.setBindGroup(1, uniformBindGroup);

    // Render fullscreen quad
    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  private applyGaussianBlurVertical(
    inputTexture: GPUTextureView,
    outputTarget: RenderTarget,
  ): void {
    // Simple render pass without complex bind group management
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: 'Gaussian Blur Vertical',
    });

    const renderPass = commandEncoder.beginRenderPass({
      label: 'Gaussian Blur Vertical Pass',
      colorAttachments: [
        {
          view: outputTarget.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    // Set technique and render pipeline
    const pipeline = this.gaussianBlurTechnique.getPipeline();
    renderPass.setPipeline(pipeline);

    // Bind texture and uniform resources
    const textureBindGroup = BindGroupFactory.createBindGroup(
      'gaussian_blur_v_texture',
      this.gaussianBlurTechnique.getBindGroupLayout(0)!,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: this.sampler },
      ],
    );

    const uniformBindGroup = BindGroupFactory.createBindGroup(
      'gaussian_blur_v_uniform',
      this.gaussianBlurTechnique.getBindGroupLayout(1)!,
      [{ binding: 0, resource: { buffer: this.gaussianBlurUniformBuffer } }],
    );

    renderPass.setBindGroup(0, textureBindGroup);
    renderPass.setBindGroup(1, uniformBindGroup);

    // Render fullscreen quad
    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Update the direction in the Gaussian blur uniform buffer
   */
  private updateGaussianBlurDirection(dirX: number, dirY: number): void {
    // Update only the direction part of the uniform buffer (offset 32 bytes = 8 floats)
    const directionData = new Float32Array([dirX, dirY, 0.0, 0.0]);
    GPUUtils.writeBuffer(this.gaussianBlurUniformBuffer, 32, directionData);
  }

  // Gaussian blur parameter setters
  public setGaussianBlurDistance(distance: number): void {
    this.globalDistance = distance;
    this.updateGaussianBlurParams();
  }

  public setBlurStrength(strength: number): void {
    const newStrength = Math.max(0.1, Math.min(5.0, strength));
    this.setGaussianBlurDistance(newStrength);
  }

  public getBlurStrength(): number {
    return this.globalDistance;
  }

  public setMaxBlurSteps(steps: number): void {
    this.maxBlurSteps = Math.max(1, Math.min(8, steps));
    // Recreate blur steps with new count
    this.createBlurSteps();
  }

  public getMaxBlurSteps(): number {
    return this.maxBlurSteps;
  }

  public resize(): void {
    // Dispose of any existing blur steps
    this.steps.forEach((step) => step.dispose());
    this.steps = [];

    // Recreate blur steps with new screen resolution
    this.createBlurSteps();
  }

  public update(_deltaTime: number): void {
    // Component update logic if needed
  }

  public renderDebug(): void {
    // Debug rendering if needed
  }

  public dispose(): void {
    this.steps.forEach((step) => step.dispose());
    this.gaussianBlurUniformBuffer?.destroy();
  }
}
