import { BindGroupFactory } from '../factories/BindGroupFactory';
import { ComputePipelineConfig, PipelineFactory } from '../factories/PipelineFactory';
import { GPUUtils } from '../utils/GPUUtils';

export class MipmapGenerator {
  private device!: GPUDevice;
  private baseShaderCode!: string;
  private pipelines: Map<GPUTextureFormat, GPUComputePipeline> = new Map();
  private bindGroupLayouts: Map<GPUTextureFormat, GPUBindGroupLayout> = new Map();
  private isInitialized = false;

  async initialize(): Promise<void> {
    this.device = GPUUtils.getDevice();

    // Load the base shader template
    const shaderResponse = await fetch('/assets/shaders/generate_mipmap.wgsl');
    this.baseShaderCode = await shaderResponse.text();

    this.isInitialized = true;
  }

  private createShaderForFormat(format: GPUTextureFormat): string {
    // Replace the hardcoded format in the shader with the actual format
    return this.baseShaderCode.replace('rgba16float', format);
  }

  private getOrCreatePipeline(format: GPUTextureFormat): {
    pipeline: GPUComputePipeline;
    bindGroupLayout: GPUBindGroupLayout;
  } {
    if (!this.pipelines.has(format)) {
      // Create shader module for this specific format
      const shaderCode = this.createShaderForFormat(format);
      const shaderModule = this.device.createShaderModule({
        label: `Mipmap Generation Compute Shader ${format}`,
        code: shaderCode,
      });

      // Create bind group layout for this format
      const bindGroupLayout = BindGroupFactory.getLayout(`mipmap_generation_${format}`, [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: {
            viewDimension: '2d',
            sampleType: 'float',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: format, // Use the actual texture format
            viewDimension: '2d',
          },
        },
      ]);

      // Create compute pipeline for this format
      const computeConfig: ComputePipelineConfig = {
        label: `Mipmap Generation Pipeline ${format}`,
        layout: PipelineFactory.createPipelineLayout(
          `mipmap_generation_pipeline_layout_${format}`,
          [bindGroupLayout],
        ),
        compute: {
          module: shaderModule,
          entryPoint: 'main',
        },
      };

      const pipeline = PipelineFactory.createComputePipeline(computeConfig);

      this.pipelines.set(format, pipeline);
      this.bindGroupLayouts.set(format, bindGroupLayout);
    }

    return {
      pipeline: this.pipelines.get(format)!,
      bindGroupLayout: this.bindGroupLayouts.get(format)!,
    };
  }

  generateMipmapsForCubemap(texture: GPUTexture, mipLevelCount: number): void {
    if (!this.isInitialized) {
      throw new Error('MipmapGenerator not initialized');
    }

    // Get pipeline and bind group layout for this texture format
    const { pipeline, bindGroupLayout } = this.getOrCreatePipeline(texture.format);

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Cubemap Mipmap Generation Command Encoder',
    });

    // Generate mipmaps for each face (0-5) and each mip level
    for (let face = 0; face < 6; face++) {
      for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        // Calculate dimensions for this mip level
        const currentSize = Math.max(1, texture.width >> mipLevel);

        // Create views for source (previous mip level) and destination (current mip level)
        const sourceView = texture.createView({
          label: `Cubemap Face ${face} Mip ${mipLevel - 1} Source`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: mipLevel - 1,
          mipLevelCount: 1,
        });

        const destView = texture.createView({
          label: `Cubemap Face ${face} Mip ${mipLevel} Destination`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: mipLevel,
          mipLevelCount: 1,
        });
        // Create bind group for this mip level generation
        const bindGroup = BindGroupFactory.createBindGroup(
          `Mipmap Generation Face ${face} Level ${mipLevel}`,
          bindGroupLayout,
          [
            {
              binding: 0,
              resource: sourceView,
            },
            {
              binding: 1,
              resource: destView,
            },
          ],
        );

        // Dispatch compute shader
        const computePass = commandEncoder.beginComputePass({
          label: `Mipmap Generation Face ${face} Level ${mipLevel}`,
        });

        computePass.setPipeline(pipeline);
        computePass.setBindGroup(0, bindGroup);

        // Calculate workgroup dispatch size
        const workgroupsX = Math.ceil(currentSize / 8);
        const workgroupsY = Math.ceil(currentSize / 8);
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY);

        computePass.end();
      }
    }

    this.device.queue.submit([commandEncoder.finish()]);
  }

  generateMipmapsFor2D(texture: GPUTexture, mipLevelCount: number): void {
    if (!this.isInitialized) {
      throw new Error('MipmapGenerator not initialized');
    }

    // Get pipeline and bind group layout for this texture format
    const { pipeline, bindGroupLayout } = this.getOrCreatePipeline(texture.format);

    const commandEncoder = this.device.createCommandEncoder({
      label: '2D Texture Mipmap Generation Command Encoder',
    });

    // Generate mipmaps for each mip level
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
      // Calculate dimensions for this mip level
      const currentSize = Math.max(1, texture.width >> mipLevel);

      // Create views for source (previous mip level) and destination (current mip level)
      const sourceView = texture.createView({
        label: `2D Mip ${mipLevel - 1} Source`,
        dimension: '2d',
        baseMipLevel: mipLevel - 1,
        mipLevelCount: 1,
      });

      const destView = texture.createView({
        label: `2D Mip ${mipLevel} Destination`,
        dimension: '2d',
        baseMipLevel: mipLevel,
        mipLevelCount: 1,
      });

      // Create bind group for this mip level generation
      const bindGroup = BindGroupFactory.createBindGroup(
        `2D Mipmap Generation Level ${mipLevel}`,
        bindGroupLayout,
        [
          {
            binding: 0,
            resource: sourceView,
          },
          {
            binding: 1,
            resource: destView,
          },
        ],
      );

      // Dispatch compute shader
      const computePass = commandEncoder.beginComputePass({
        label: `2D Mipmap Generation Level ${mipLevel}`,
      });

      computePass.setPipeline(pipeline);
      computePass.setBindGroup(0, bindGroup);

      // Calculate workgroup dispatch size
      const workgroupsX = Math.ceil(currentSize / 8);
      const workgroupsY = Math.ceil(currentSize / 8);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY);

      computePass.end();
    }

    this.device.queue.submit([commandEncoder.finish()]);
  }

  dispose(): void {
    // WebGPU resources are garbage collected automatically
    this.isInitialized = false;
  }
}
