import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import {
  PipelineFactory,
  ComputePipelineConfig,
} from '../../renderer/core/factories/PipelineFactory';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

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

  // Mip chain and result textures
  private mipChain: RenderTarget[] = [];
  private accumChain: RenderTarget[] = []; // Accumulation textures for upsample
  private fullSizeResult: RenderTarget | null = null; // Final full-size bloom result
  private finalCombinedResult: RenderTarget | null = null; // Final combined result (original + bloom)
  private numMips = 0;

  // Uniform buffers
  private downsampleParamsBuffer!: GPUBuffer;

  // Bind groups for each mip level
  private downsampleBindGroups: GPUBindGroup[] = [];
  private upsampleBindGroups: GPUBindGroup[] = [];
  private combineBindGroup: GPUBindGroup | null = null;

  // Sampler
  private linearSampler!: GPUSampler;

  constructor() {
    super();
    this.device = Render.getInstance().getDevice();
  }

  public async load(): Promise<void> {
    this.numMips = QualitySettings.getInstance().getSettings().bloomNumMips;
    await this.initializeComputeShaders();
    await this.createComputePipelines();
    this.createUniformBuffers();
    this.initializeMipChain();
    this.isLoaded = true;
  }

  public resize(): void {
    if (!this.isLoaded) return;

    // Destroy existing mip chain
    this.destroyMipChain();

    // Recreate with new dimensions
    this.initializeMipChain();
  }

  public apply(sourceTexture: GPUTextureView): GPUTextureView {
    if (!this.isLoaded || this.mipChain.length === 0) {
      return sourceTexture;
    }

    // Execute complete bloom pipeline with guaranteed synchronization
    this.performDownsample(sourceTexture);
    this.performUpsample();
    this.performCombine(sourceTexture);

    // Return the final combined result
    return this.finalCombinedResult!.getView();
  }

  private async initializeComputeShaders(): Promise<void> {
    // Load downsample compute shader
    const downsampleResponse = await fetch(
      `${import.meta.env.BASE_URL}assets/shaders/bloom_downsample.cs`,
    );
    const downsampleCode = await downsampleResponse.text();

    this.downsampleShader = this.device.createShaderModule({
      label: 'Bloom Downsample Compute Shader',
      code: downsampleCode,
    });

    // Load upsample compute shader
    const upsampleResponse = await fetch(
      `${import.meta.env.BASE_URL}assets/shaders/bloom_upsample.cs`,
    );
    const upsampleCode = await upsampleResponse.text();

    this.upsampleShader = this.device.createShaderModule({
      label: 'Bloom Upsample Compute Shader',
      code: upsampleCode,
    });

    // Load combine compute shader
    const combineResponse = await fetch(
      `${import.meta.env.BASE_URL}assets/shaders/bloom_combine.cs`,
    );
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
        texture: { sampleType: 'float' }, // source texture (smaller mip)
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' }, // filtering sampler
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
        }, // destination texture (larger mip)
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
    this.linearSampler = SamplerLibrary.bloom;

    // Downsample parameters: srcResolution (vec2) + padding
    this.downsampleParamsBuffer = GPUUtils.createBuffer(
      'bloom_downsample_compute_params',
      16, // 2 floats + 2 padding = 16 bytes (vec4<f32>)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  private initializeMipChain(): void {
    // Use rgba16float for compute shader compatibility
    const bloomFormat = QualitySettings.getInstance().getSettings().bloomTexture;

    const baseWidth = Render.width;
    const baseHeight = Render.height;

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

    // Create full-size result texture for final bloom
    this.fullSizeResult = new RenderTarget();
    this.fullSizeResult.createRT(
      'bloom_full_size_result',
      baseWidth,
      baseHeight,
      bloomFormat,
      false,
      GPUTextureUsage.STORAGE_BINDING,
    );

    // Create final combined result texture (original + bloom)
    this.finalCombinedResult = new RenderTarget();
    this.finalCombinedResult.createRT(
      'bloom_final_combined_result',
      baseWidth,
      baseHeight,
      bloomFormat,
      false,
      GPUTextureUsage.STORAGE_BINDING,
    );
  }

  private createBindGroupsForMip(mipIndex: number): void {
    // Create downsample bind group only for mipIndex > 0
    // mipIndex === 0 always uses dynamic bind group with source texture
    if (mipIndex > 0) {
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
            resource: this.mipChain[mipIndex - 1]!.getTexture().createView(), // Previous mip as source
          },
          {
            binding: 2,
            resource: this.linearSampler,
          },
          {
            binding: 3,
            resource: this.mipChain[mipIndex]!.getStorageView(), // Current mip as destination
          },
        ],
      );
      this.downsampleBindGroups[mipIndex] = downsampleBindGroup;
    }

    // Create upsample bind group (for progressive upsampling)
    if (mipIndex > 0) {
      const upsampleBindGroup = BindGroupFactory.createBindGroup(
        `bloom_upsample_mip_${mipIndex}`,
        this.upsampleBindGroupLayout,
        [
          {
            binding: 0,
            resource: this.accumChain[mipIndex]!.getTexture().createView(), // Source (accumulated smaller mip)
          },
          {
            binding: 1,
            resource: this.linearSampler,
          },
          {
            binding: 2,
            resource: this.accumChain[mipIndex - 1]!.getStorageView(), // Destination (larger accumulation texture)
          },
        ],
      );

      this.upsampleBindGroups[mipIndex] = upsampleBindGroup;
    }
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

  private performDownsample(sourceTexture: GPUTextureView): void {
    // Execute each mip with separate submissions for guaranteed ordering
    for (let i = 0; i < this.mipChain.length; i++) {
      // Create individual command encoder for complete isolation
      const device = Render.getInstance().getDevice();
      const commandEncoder = device.createCommandEncoder({
        label: `bloom_downsample_mip_${i}`,
      });

      // Determine source resolution and texture
      const srcResolution =
        i === 0
          ? [Render.width, Render.height]
          : [this.mipChain[i - 1]!.getWidth(), this.mipChain[i - 1]!.getHeight()];

      const sourceTextureForThisPass = i === 0 ? sourceTexture : this.mipChain[i - 1]!.getView();

      // Update parameters for this specific mip
      this.updateDownsampleParams(srcResolution);

      // Create compute pass
      const computePass = commandEncoder.beginComputePass({
        label: `bloom_downsample_mip_${i}`,
      });

      computePass.setPipeline(this.downsamplePipeline);

      // Create bind group for this specific pass
      const bindGroup = BindGroupFactory.createBindGroup(
        `bloom_downsample_mip_${i}_separate`,
        this.downsampleBindGroupLayout,
        [
          {
            binding: 0,
            resource: { buffer: this.downsampleParamsBuffer },
          },
          {
            binding: 1,
            resource: sourceTextureForThisPass,
          },
          {
            binding: 2,
            resource: this.linearSampler,
          },
          {
            binding: 3,
            resource: this.mipChain[i]!.getStorageView(),
          },
        ],
      );

      computePass.setBindGroup(0, bindGroup);

      // Calculate dispatch size
      const mipWidth = this.mipChain[i]!.getWidth();
      const mipHeight = this.mipChain[i]!.getHeight();
      const dispatchX = Math.ceil(mipWidth / 8);
      const dispatchY = Math.ceil(mipHeight / 8);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      computePass.end();

      // CRITICAL: Submit this command encoder immediately and wait for completion
      const commandBuffer = commandEncoder.finish();
      device.queue.submit([commandBuffer]);
    }
  }

  private performUpsample(): void {
    // Simplified progressive upsample: use mip chain directly for upsampling
    // Start from the smallest mip and progressively upsample to larger sizes

    for (let i = this.mipChain.length - 1; i > 0; i--) {
      const device = Render.getInstance().getDevice();
      const commandEncoder = device.createCommandEncoder({
        label: `bloom_upsample_step_${i}`,
      });

      const computePass = commandEncoder.beginComputePass({
        label: `bloom_upsample_step_${i}`,
      });

      computePass.setPipeline(this.upsamplePipeline);

      // Create bind group dynamically for this step
      // Source: smaller mip (mipChain[i])
      // Destination: larger mip (mipChain[i-1]) - we'll overwrite it with upsampled + original
      const bindGroup = BindGroupFactory.createBindGroup(
        `bloom_upsample_step_${i}_dynamic`,
        this.upsampleBindGroupLayout,
        [
          {
            binding: 0,
            resource: this.mipChain[i]!.getView(), // Source (smaller mip)
          },
          {
            binding: 1,
            resource: this.linearSampler,
          },
          {
            binding: 2,
            resource: this.mipChain[i - 1]!.getStorageView(), // Destination (larger mip, will be overwritten)
          },
        ],
      );

      computePass.setBindGroup(0, bindGroup);

      // Calculate dispatch size for destination (larger) texture
      const dstWidth = this.mipChain[i - 1]!.getWidth();
      const dstHeight = this.mipChain[i - 1]!.getHeight();
      const dispatchX = Math.ceil(dstWidth / 8);
      const dispatchY = Math.ceil(dstHeight / 8);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      computePass.end();

      // Submit immediately for guaranteed ordering
      const commandBuffer = commandEncoder.finish();
      device.queue.submit([commandBuffer]);
    }

    // Final upsample from mip[0] to full size
    this.performFinalUpsample();
  }

  private performFinalUpsample(): void {
    // Final upsample from mip[0] to full size result
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: 'bloom_final_upsample',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'bloom_final_upsample',
    });

    computePass.setPipeline(this.upsamplePipeline);

    // Create dynamic bind group for final upsample
    const finalBindGroup = BindGroupFactory.createBindGroup(
      'bloom_final_upsample_dynamic',
      this.upsampleBindGroupLayout,
      [
        {
          binding: 0,
          resource: this.mipChain[0]!.getView(), // Source (mip 0)
        },
        {
          binding: 1,
          resource: this.linearSampler,
        },
        {
          binding: 2,
          resource: this.fullSizeResult!.getStorageView(), // Destination (full size)
        },
      ],
    );

    computePass.setBindGroup(0, finalBindGroup);

    const dstWidth = this.fullSizeResult!.getWidth();
    const dstHeight = this.fullSizeResult!.getHeight();
    const dispatchX = Math.ceil(dstWidth / 8);
    const dispatchY = Math.ceil(dstHeight / 8);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    computePass.end();

    const commandBuffer = commandEncoder.finish();
    device.queue.submit([commandBuffer]);
  }

  private performCombine(originalTexture: GPUTextureView): void {
    // Execute combine with separate submission
    const device = Render.getInstance().getDevice();
    const commandEncoder = device.createCommandEncoder({
      label: 'bloom_combine',
    });

    // Create bind group for combine pass
    this.combineBindGroup = BindGroupFactory.createBindGroup(
      'bloom_combine_final',
      this.combineBindGroupLayout,
      [
        {
          binding: 0,
          resource: originalTexture, // Original texture
        },
        {
          binding: 1,
          resource: this.fullSizeResult!.getView(), // Bloom texture
        },
        {
          binding: 2,
          resource: this.linearSampler,
        },
        {
          binding: 3,
          resource: this.finalCombinedResult!.getStorageView(), // Final result
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

    // Submit immediately
    const commandBuffer = commandEncoder.finish();
    device.queue.submit([commandBuffer]);
  }

  public update(_dt: number): void {
    // Update logic if needed
  }

  public dispose(): void {
    this.destroyMipChain();

    if (this.downsampleParamsBuffer) {
      this.downsampleParamsBuffer.destroy();
    }

    // Clear bind group arrays
    this.downsampleBindGroups = [];
    this.upsampleBindGroups = [];
  }

  public override renderDebug(): void {
    // Debug implementation if needed
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

    this.combineBindGroup = null;
  }
}
