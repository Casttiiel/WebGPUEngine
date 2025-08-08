import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';

/**
 * High-performance Bloom Component using Compute Shaders
 * Implements Call of Duty: Advanced Warfare technique with GPU optimization
 */
export class BloomComponent extends Component {
  private device: GPUDevice;
  private isLoaded = false;

  // Compute shaders and pipelines
  private downsampleShader!: GPUShaderModule;
  private upsampleShader!: GPUShaderModule;
  private combineShader!: GPUShaderModule;
  private downsamplePipeline!: GPUComputePipeline;
  private upsamplePipeline!: GPUComputePipeline;
  private combinePipeline!: GPUComputePipeline;

  // Bind group layouts
  private downsampleBindGroupLayout!: GPUBindGroupLayout;
  private upsampleBindGroupLayout!: GPUBindGroupLayout;
  private combineBindGroupLayout!: GPUBindGroupLayout;

  // Mip chain for progressive downsampling/upsampling
  private mipChain: RenderTarget[] = [];
  private accumChain: RenderTarget[] = []; // Separate accumulation textures for upsample
  private fullSizeResult: RenderTarget | null = null; // Final full-size result
  private finalCombinedResult: RenderTarget | null = null; // Final combined result (original + bloom)
  private numMips = 6; // Default number of mips (3-8 range)

  // Uniform buffers
  private downsampleParamsBuffer!: GPUBuffer;
  private upsampleParamsBuffer!: GPUBuffer;

  // Bind groups for each mip level
  private downsampleBindGroups: GPUBindGroup[] = [];
  private upsampleBindGroups: GPUBindGroup[] = [];
  private fullSizeUpsampleBindGroup: GPUBindGroup | null = null; // Final upsample to full size
  private combineBindGroup: GPUBindGroup | null = null; // Combine original + bloom

  // Parameters
  private filterRadius = 0.005; // Filter radius for upsampling
  private bloomStrength = 0.04; // Final bloom mix strength

  // Sampler
  private linearSampler!: GPUSampler;

  constructor() {
    super();
    this.device = Render.getInstance().getDevice();
  }

  public async load(): Promise<void> {
    await this.initializeComputeShaders();
    await this.createComputePipelines();
    this.createUniformBuffers();
    this.initializeMipChain();
    this.isLoaded = true;
  }

  public attach(_entity: Entity): void {
    // Store entity reference if needed
  }

  public resize(): void {
    if (!this.isLoaded) return;

    // Destroy existing mip chain
    this.destroyMipChain();

    // Recreate with new dimensions
    this.initializeMipChain();
  }

  private async initializeComputeShaders(): Promise<void> {
    // Load downsample compute shader
    const downsampleResponse = await fetch('/assets/shaders/bloom_downsample.cs');
    const downsampleCode = await downsampleResponse.text();

    this.downsampleShader = this.device.createShaderModule({
      label: 'Bloom Downsample Compute Shader',
      code: downsampleCode,
    });

    // Load upsample compute shader
    const upsampleResponse = await fetch('/assets/shaders/bloom_upsample.cs');
    const upsampleCode = await upsampleResponse.text();

    this.upsampleShader = this.device.createShaderModule({
      label: 'Bloom Upsample Compute Shader',
      code: upsampleCode,
    });

    // Load combine compute shader
    const combineResponse = await fetch('/assets/shaders/bloom_combine.cs');
    const combineCode = await combineResponse.text();

    this.combineShader = this.device.createShaderModule({
      label: 'Bloom Combine Compute Shader',
      code: combineCode,
    });
  }

  private async createComputePipelines(): Promise<void> {
    // Create downsample bind group layout
    this.downsampleBindGroupLayout = BindGroupFactory.getLayout('bloom_downsample_compute', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // downsample params
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' }, // source texture
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' }, // filtering sampler
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
        }, // destination texture
      },
    ]);

    // Create upsample bind group layout
    this.upsampleBindGroupLayout = BindGroupFactory.getLayout('bloom_upsample_compute', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // upsample params
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' }, // source texture (smaller mip)
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' }, // filtering sampler
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
        }, // destination texture (larger mip, with additive blending)
      },
    ]);

    // Create combine bind group layout
    this.combineBindGroupLayout = BindGroupFactory.getLayout('bloom_combine_compute', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' }, // original texture
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' }, // bloom texture
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' }, // texture sampler
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
        }, // result texture
      },
    ]);

    // Create downsample compute pipeline
    const downsampleConfig: ComputePipelineConfig = {
      label: 'Bloom Downsample Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('bloom_downsample_pipeline_layout', [
        this.downsampleBindGroupLayout,
      ]),
      compute: {
        module: this.downsampleShader,
        entryPoint: 'cs',
      },
    };

    this.downsamplePipeline = PipelineFactory.createComputePipeline(downsampleConfig);

    // Create upsample compute pipeline
    const upsampleConfig: ComputePipelineConfig = {
      label: 'Bloom Upsample Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('bloom_upsample_pipeline_layout', [
        this.upsampleBindGroupLayout,
      ]),
      compute: {
        module: this.upsampleShader,
        entryPoint: 'cs',
      },
    };

    this.upsamplePipeline = PipelineFactory.createComputePipeline(upsampleConfig);

    // Create combine compute pipeline
    const combineConfig: ComputePipelineConfig = {
      label: 'Bloom Combine Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('bloom_combine_pipeline_layout', [
        this.combineBindGroupLayout,
      ]),
      compute: {
        module: this.combineShader,
        entryPoint: 'cs',
      },
    };

    this.combinePipeline = PipelineFactory.createComputePipeline(combineConfig);
  }

  private createUniformBuffers(): void {
    // Create linear sampler for texture sampling
    this.linearSampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Downsample parameters: srcResolution (vec2) + padding
    this.downsampleParamsBuffer = GPUUtils.createBuffer(
      'bloom_downsample_compute_params',
      16, // 2 floats + 2 padding = 16 bytes (vec4<f32>)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Upsample parameters: filterRadius (float) + padding
    this.upsampleParamsBuffer = GPUUtils.createBuffer(
      'bloom_upsample_compute_params',
      16, // 1 float + 3 padding = 16 bytes (vec4<f32>)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Update filter radius
    this.updateUpsampleParams();
  }

  private initializeMipChain(): void {
    // Use rgba16float for compute shader compatibility
    const bloomFormat: GPUTextureFormat = 'rgba16float';

    const baseWidth = Render.width;
    const baseHeight = Render.height;

    // Create full-size result texture (original size)
    this.fullSizeResult = new RenderTarget();
    this.fullSizeResult.createRT(
      'bloom_full_size_result',
      baseWidth,
      baseHeight,
      bloomFormat,
      false, // No MSAA for bloom textures
      GPUTextureUsage.STORAGE_BINDING, // Allow use as storage texture in compute shaders
    );

    // Create final combined result texture (original + bloom)
    this.finalCombinedResult = new RenderTarget();
    this.finalCombinedResult.createRT(
      'bloom_final_combined_result',
      baseWidth,
      baseHeight,
      bloomFormat,
      false, // No MSAA for bloom textures
      GPUTextureUsage.STORAGE_BINDING, // Allow use as storage texture in compute shaders
    );

    // Create mip chain (each level is half the resolution)
    for (let i = 0; i < this.numMips; i++) {
      const mipWidth = Math.max(1, Math.floor(baseWidth / Math.pow(2, i + 1)));
      const mipHeight = Math.max(1, Math.floor(baseHeight / Math.pow(2, i + 1)));

      // Create downsample target
      const renderTarget = new RenderTarget();
      renderTarget.createRT(
        `bloom_mip_${i}`,
        mipWidth,
        mipHeight,
        bloomFormat,
        false, // No MSAA for bloom textures
        GPUTextureUsage.STORAGE_BINDING, // Allow use as storage texture in compute shaders
      );

      this.mipChain.push(renderTarget);

      // Create accumulation target (same size as mip level)
      const accumTarget = new RenderTarget();
      accumTarget.createRT(
        `bloom_accum_${i}`,
        mipWidth,
        mipHeight,
        bloomFormat,
        false, // No MSAA for bloom textures
        GPUTextureUsage.STORAGE_BINDING, // Allow use as storage texture in compute shaders
      );

      this.accumChain.push(accumTarget);

      // Create bind groups for this mip level
      this.createBindGroupsForMip(i);
    }

    // Create bind group for final upsample to full size
    this.createFullSizeUpsampleBindGroup();
  }

  private createBindGroupsForMip(mipIndex: number): void {
    // Create downsample bind group
    if (mipIndex < this.mipChain.length) {
      const downsampleBindGroup = BindGroupFactory.createBindGroup(
        `bloom_downsample_mip_${mipIndex}`,
        this.downsampleBindGroupLayout,
        [
          {
            binding: 0,
            resource: { buffer: this.downsampleParamsBuffer },
          },
          {
            binding: 1,
            resource:
              mipIndex === 0
                ? // First mip uses the source texture (will be set dynamically)
                  this.mipChain[0]!.getTexture().createView()
                : this.mipChain[mipIndex - 1]!.getTexture().createView(),
          },
          {
            binding: 2,
            resource: this.linearSampler,
          },
          {
            binding: 3,
            resource: this.mipChain[mipIndex]!.getTexture().createView(),
          },
        ],
      );

      this.downsampleBindGroups[mipIndex] = downsampleBindGroup;
    }

    // Create upsample bind group (for upsampling from smaller to larger mip)
    if (mipIndex > 0) {
      const upsampleBindGroup = BindGroupFactory.createBindGroup(
        `bloom_upsample_mip_${mipIndex}`,
        this.upsampleBindGroupLayout,
        [
          {
            binding: 0,
            resource: { buffer: this.upsampleParamsBuffer },
          },
          {
            binding: 1,
            resource: this.mipChain[mipIndex]!.getTexture().createView(), // Source (smaller mip)
          },
          {
            binding: 2,
            resource: this.linearSampler,
          },
          {
            binding: 3,
            resource: this.accumChain[mipIndex - 1]!.getTexture().createView(), // Destination (accumulation texture)
          },
        ],
      );

      this.upsampleBindGroups[mipIndex] = upsampleBindGroup;
    }
  }

  private createFullSizeUpsampleBindGroup(): void {
    // Create bind group for final upsample from mip 0 to full size
    this.fullSizeUpsampleBindGroup = BindGroupFactory.createBindGroup(
      'bloom_upsample_full_size',
      this.upsampleBindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.upsampleParamsBuffer },
        },
        {
          binding: 1,
          resource: this.accumChain[0]!.getTexture().createView(), // Source (accumulated mip 0)
        },
        {
          binding: 2,
          resource: this.linearSampler,
        },
        {
          binding: 3,
          resource: this.fullSizeResult!.getTexture().createView(), // Destination (full size)
        },
      ],
    );
  }

  private updateDownsampleParams(resolution: number[]): void {
    const paramsData = new Float32Array([
      resolution[0] || 0, // srcResolution.x
      resolution[1] || 0, // srcResolution.y
      0.0, // padding
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.downsampleParamsBuffer, 0, paramsData);
  }

  private updateUpsampleParams(): void {
    const paramsData = new Float32Array([
      this.filterRadius, // filterRadius
      0.0, // padding
      0.0, // padding
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.upsampleParamsBuffer, 0, paramsData);
  }

  public apply(sourceTexture: GPUTextureView): GPUTextureView {
    if (!this.isLoaded || this.mipChain.length === 0) {
      return sourceTexture;
    }

    const commandEncoder = Render.getInstance().getCommandEncoder();

    // Phase 1: Downsample - create mip chain
    this.performDownsample(commandEncoder, sourceTexture);

    // Phase 2: Upsample - progressive accumulation with additive blending
    this.performUpsample(commandEncoder);

    // Phase 3: Combine original + bloom
    this.performCombine(commandEncoder, sourceTexture, this.fullSizeResult!.getView());

    // Return the final combined result
    return this.finalCombinedResult!.getView();
  }

  private performDownsample(
    commandEncoder: GPUCommandEncoder,
    sourceTexture: GPUTextureView,
  ): void {
    for (let i = 0; i < this.mipChain.length; i++) {
      // Update downsample parameters for this specific step
      const srcResolution =
        i === 0
          ? [Render.width, Render.height] // First mip uses full resolution
          : [this.mipChain[i - 1]!.getWidth(), this.mipChain[i - 1]!.getHeight()];

      this.updateDownsampleParams(srcResolution);

      const computePass = commandEncoder.beginComputePass({
        label: `bloom_downsample_mip_${i}`,
      });

      computePass.setPipeline(this.downsamplePipeline);

      // For first mip, we need to bind the source texture dynamically
      if (i === 0) {
        // Create temporary bind group with source texture
        const tempBindGroup = BindGroupFactory.createBindGroup(
          `bloom_downsample_source`,
          this.downsampleBindGroupLayout,
          [
            {
              binding: 0,
              resource: { buffer: this.downsampleParamsBuffer },
            },
            {
              binding: 1,
              resource: sourceTexture,
            },
            {
              binding: 2,
              resource: this.linearSampler,
            },
            {
              binding: 3,
              resource: this.mipChain[i]!.getTexture().createView(),
            },
          ],
        );
        computePass.setBindGroup(0, tempBindGroup);
      } else {
        computePass.setBindGroup(0, this.downsampleBindGroups[i]);
      }

      // Calculate dispatch size (work groups of 8x8)
      const mipWidth = this.mipChain[i]!.getWidth();
      const mipHeight = this.mipChain[i]!.getHeight();
      const dispatchX = Math.ceil(mipWidth / 8);
      const dispatchY = Math.ceil(mipHeight / 8);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      computePass.end();
    }
  }

  private performUpsample(commandEncoder: GPUCommandEncoder): void {
    // Upsample from smallest to largest (reverse order)
    // Include one extra iteration to go from mip 0 to full size
    for (let i = this.mipChain.length - 1; i >= 0; i--) {
      const computePass = commandEncoder.beginComputePass({
        label: i > 0 ? `bloom_upsample_mip_${i}` : 'bloom_upsample_full_size',
      });

      computePass.setPipeline(this.upsamplePipeline);

      // For i > 0: normal mip-to-mip upsample
      // For i = 0: mip 0 to full size upsample
      const bindGroup = i > 0 ? this.upsampleBindGroups[i] : this.fullSizeUpsampleBindGroup!;
      computePass.setBindGroup(0, bindGroup);

      // Calculate dispatch size for destination texture
      const dstWidth = i > 0 ? this.accumChain[i - 1]!.getWidth() : this.fullSizeResult!.getWidth();
      const dstHeight =
        i > 0 ? this.accumChain[i - 1]!.getHeight() : this.fullSizeResult!.getHeight();
      const dispatchX = Math.ceil(dstWidth / 8);
      const dispatchY = Math.ceil(dstHeight / 8);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      computePass.end();
    }
  }

  private performCombine(
    commandEncoder: GPUCommandEncoder,
    originalTexture: GPUTextureView,
    bloomTexture: GPUTextureView,
  ): void {
    // Create bind group for combine pass
    this.combineBindGroup = BindGroupFactory.createBindGroup(
      'bloom_combine_compute_bindgroup',
      this.combineBindGroupLayout,
      [
        {
          binding: 0,
          resource: originalTexture,
        },
        {
          binding: 1,
          resource: bloomTexture,
        },
        {
          binding: 2,
          resource: this.linearSampler,
        },
        {
          binding: 3,
          resource: this.finalCombinedResult!.getStorageView(),
        },
      ],
    );

    const computePass = commandEncoder.beginComputePass({
      label: 'bloom_combine',
    });

    computePass.setPipeline(this.combinePipeline);
    computePass.setBindGroup(0, this.combineBindGroup);

    const dispatchX = Math.ceil(this.finalCombinedResult!.getWidth() / 8);
    const dispatchY = Math.ceil(this.finalCombinedResult!.getHeight() / 8);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    computePass.end();
  }

  // Public setters for configuration
  public setNumMips(numMips: number): void {
    if (numMips !== this.numMips && numMips >= 3 && numMips <= 8) {
      this.numMips = numMips;
      if (this.isLoaded) {
        this.resize(); // Recreate mip chain
      }
    }
  }

  public setFilterRadius(radius: number): void {
    this.filterRadius = Math.max(0.001, Math.min(0.1, radius));
    if (this.isLoaded) {
      this.updateUpsampleParams();
    }
  }

  public setBloomStrength(strength: number): void {
    this.bloomStrength = Math.max(0.0, Math.min(1.0, strength));
    // Note: Bloom strength is now hardcoded in the shader to 0.04
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const componentName = 'Bloom Compute';

    const self = this;

    // Wrappers for Tweakpane reactivity
    const numMipsWrapper = {
      get numMips() {
        return self.numMips;
      },
      set numMips(value) {
        self.setNumMips(value);
      },
    };

    const filterRadiusWrapper = {
      get filterRadius() {
        return self.filterRadius;
      },
      set filterRadius(value) {
        self.setFilterRadius(value);
      },
    };

    const bloomStrengthWrapper = {
      get bloomStrength() {
        return self.bloomStrength;
      },
      set bloomStrength(value) {
        self.setBloomStrength(value);
      },
    };

    // Helper function to add controls
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addInteractiveControl(componentName, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    addControl(numMipsWrapper, 'numMips', `${componentName} Mip Levels`, {
      min: 3,
      max: 8,
      step: 1,
    });

    addControl(filterRadiusWrapper, 'filterRadius', `${componentName} Filter Radius`, {
      min: 0.001,
      max: 0.1,
      step: 0.001,
    });

    addControl(bloomStrengthWrapper, 'bloomStrength', `${componentName} Strength`, {
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });
  }

  public renderDebug(): void {
    // Debug rendering implementation
  }

  public update(_dt: number): void {
    // Update logic if needed
  }

  public dispose(): void {
    this.destroyMipChain();

    if (this.downsampleParamsBuffer) {
      this.downsampleParamsBuffer.destroy();
    }
    if (this.upsampleParamsBuffer) {
      this.upsampleParamsBuffer.destroy();
    }

    // Clear bind group arrays
    this.downsampleBindGroups = [];
    this.upsampleBindGroups = [];
  }

  private destroyMipChain(): void {
    for (const renderTarget of this.mipChain) {
      renderTarget.destroy();
    }
    this.mipChain = [];

    for (const renderTarget of this.accumChain) {
      renderTarget.destroy();
    }
    this.accumChain = [];

    if (this.fullSizeResult) {
      this.fullSizeResult.destroy();
      this.fullSizeResult = null;
    }

    if (this.finalCombinedResult) {
      this.finalCombinedResult.destroy();
      this.finalCombinedResult = null;
    }

    this.fullSizeUpsampleBindGroup = null;
  }
}
