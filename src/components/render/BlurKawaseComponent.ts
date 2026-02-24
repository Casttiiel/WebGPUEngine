import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Technique } from '../../renderer/resources/Technique';
import { Mesh } from '../../renderer/resources/Mesh';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

export class BlurStep {
  public outputTarget: RenderTarget; // Final result after downsampling
  public inputWidth: number;
  public inputHeight: number;
  public width: number;
  public height: number;

  constructor(
    name: string,
    inputWidth: number,
    inputHeight: number,
    format: GPUTextureFormat,
    downscaleFactor: number = 0.5,
  ) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;

    // Final output target (scaled width and height)
    this.outputTarget = new RenderTarget();
    this.outputTarget.createRT(
      `${name}`,
      Math.max(1, Math.floor(this.inputWidth * downscaleFactor)),
      Math.max(1, Math.floor(this.inputHeight * downscaleFactor)),
      format,
    );

    this.width = this.outputTarget.getWidth();
    this.height = this.outputTarget.getHeight();
  }

  public dispose(): void {
    this.outputTarget.destroy();
  }

  public getOutputView(): GPUTextureView {
    return this.outputTarget.getView();
  }
}

export class BlurKawaseComponent extends Component {
  protected stepsDownsample: BlurStep[] = [];
  protected sampler!: GPUSampler;
  protected maxBlurSteps: number = 5;

  private kawaseDownsampleTechnique!: Technique;
  private kawaseUpsampleTechnique!: Technique;
  private kawaseUniformBuffer!: GPUBuffer;
  private commandEncoder!: GPUCommandEncoder;
  protected fullscreenQuadMesh!: Mesh;

  // ✅ Reusable buffer to avoid allocations in update loop
  private directionData: Float32Array = new Float32Array(4);

  // ✅ Cached bind groups to avoid creation every frame (CRITICAL for performance)
  private uniformBindGroup!: GPUBindGroup;
  private textureBindGroupsCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    // Load kawase blur technique and mesh
    this.kawaseDownsampleTechnique = await Technique.getAsync(
      'post-processing/kawase_downsample.tech',
    );

    this.kawaseUpsampleTechnique = await Technique.getAsync('post-processing/kawase_upsample.tech');

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Create uniform buffer for Kawase blur parameters
    this.kawaseUniformBuffer = GPUUtils.createBuffer(
      'kawase_blur_uniforms',
      64,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Create sampler for texture sampling
    this.sampler = SamplerLibrary.bloom;

    // ✅ Create cached uniform bind group (reused every frame)
    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      'kawase_blur_uniform_cached',
      this.kawaseDownsampleTechnique.getBindGroupLayout(1)!,
      [{ binding: 0, resource: { buffer: this.kawaseUniformBuffer } }],
    );

    this.createBlurSteps();
  }

  private getOrCreateTextureBindGroup(texture: GPUTextureView): GPUBindGroup {
    // Check cache first
    let bindGroup = this.textureBindGroupsCache.get(texture);
    if (!bindGroup) {
      // Create and cache new bind group
      bindGroup = BindGroupFactory.createBindGroup(
        'kawase_blur_texture_cached',
        this.kawaseDownsampleTechnique.getBindGroupLayout(0)!,
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: this.sampler },
        ],
      );
      this.textureBindGroupsCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  private createBlurSteps(): void {
    const bloomFormat = QualitySettings.getInstance().getSettings().bloomTexture;

    // Clear existing steps
    this.stepsDownsample.forEach((step) => step.dispose());
    this.stepsDownsample = [];

    // ✅ Clear bind group cache when recreating steps (resolution change)
    this.textureBindGroupsCache.clear();

    // Downsample steps
    let inputWidth = Render.width;
    let inputHeight = Render.height;

    for (let i = 0; i < this.maxBlurSteps; i++) {
      const step = new BlurStep(`kawase_downsample_${i}`, inputWidth, inputHeight, bloomFormat);
      this.stepsDownsample.push(step);

      // Next step uses adaptive downscale factor
      inputWidth = Math.max(1, Math.floor(inputWidth * 0.5));
      inputHeight = Math.max(1, Math.floor(inputHeight * 0.5));
    }
  }

  public applyBlur(inputTexture: GPUTextureView): GPUTextureView {
    if (this.stepsDownsample.length === 0) return inputTexture;

    let currentInput = inputTexture;
    let currentWidth = Render.width;
    let currentHeight = Render.height;

    const device = Render.getInstance().getDevice();
    this.commandEncoder = device.createCommandEncoder({
      label: 'Kawase Bloom',
    });

    this.updateBloomSize(1.0);

    // Apply Downscale to each step sequentially, using output of previous step as input
    for (let i = 0; i < this.maxBlurSteps && i < this.stepsDownsample.length; i++) {
      const step = this.stepsDownsample[i];
      if (!step) continue;

      this.applyDownsample(currentInput, step.outputTarget);

      currentWidth = step.width;
      currentHeight = step.height;
      currentInput = step.getOutputView();
    }

    // Apply Upscale to each step sequentially, using output of previous step as input
    for (let i = this.stepsDownsample.length - 2; i >= 0; i--) {
      const step = this.stepsDownsample[i];
      if (!step) continue;

      this.applyUpsample(currentInput, step.outputTarget);

      currentWidth = step.width;
      currentHeight = step.height;
      currentInput = step.getOutputView();
    }

    device.queue.submit([this.commandEncoder.finish()]);

    return currentInput;
  }

  private applyDownsample(inputTexture: GPUTextureView, outputTarget: RenderTarget): void {
    const renderPass = this.commandEncoder.beginRenderPass({
      label: 'Kawase Downsample Pass',
      colorAttachments: [
        {
          view: outputTarget.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    GPUUtils.configureViewportAndScissor(
      renderPass,
      outputTarget.getWidth(),
      outputTarget.getHeight(),
    );

    // Set technique and render pipeline
    const pipeline = this.kawaseDownsampleTechnique.getPipeline();
    renderPass.setPipeline(pipeline);

    // ✅ Use cached bind groups instead of creating new ones every frame
    const textureBindGroup = this.getOrCreateTextureBindGroup(inputTexture);
    renderPass.setBindGroup(0, textureBindGroup);
    renderPass.setBindGroup(1, this.uniformBindGroup);

    // Render fullscreen quad
    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);
    renderPass.end();
  }

  private applyUpsample(inputTexture: GPUTextureView, outputTarget: RenderTarget): void {
    const renderPass = this.commandEncoder.beginRenderPass({
      label: 'Kawase Upsample Pass',
      colorAttachments: [
        {
          view: outputTarget.getView(),
          loadOp: 'load',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    GPUUtils.configureViewportAndScissor(
      renderPass,
      outputTarget.getWidth(),
      outputTarget.getHeight(),
    );

    // Set technique and render pipeline
    const pipeline = this.kawaseUpsampleTechnique.getPipeline();
    renderPass.setPipeline(pipeline);

    // ✅ Use cached bind groups instead of creating new ones every frame
    const textureBindGroup = this.getOrCreateTextureBindGroup(inputTexture);
    renderPass.setBindGroup(0, textureBindGroup);
    renderPass.setBindGroup(1, this.uniformBindGroup);

    // Render fullscreen quad
    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);
    renderPass.end();
  }

  private updateBloomSize(size: number): void {
    this.directionData[0] = size;
    this.directionData[1] = 0;
    this.directionData[2] = 0.0;
    this.directionData[3] = 0.0;
    GPUUtils.writeBuffer(this.kawaseUniformBuffer, 0, this.directionData);
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
    this.stepsDownsample.forEach((step) => step.dispose());
    this.stepsDownsample = [];

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
    this.stepsDownsample.forEach((step) => step.dispose());
    this.kawaseUniformBuffer?.destroy();
  }
}
