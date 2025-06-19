import { Render } from '../core/Render';

export class MipmapGenerator {
  private device!: GPUDevice;
  private computePipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private isInitialized = false;

  async initialize(): Promise<void> {
    this.device = Render.getInstance().getDevice();

    // Load and compile the compute shader
    const shaderResponse = await fetch('/assets/shaders/generate_mipmap.wgsl');
    const shaderCode = await shaderResponse.text();

    const shaderModule = this.device.createShaderModule({
      label: 'Mipmap Generation Compute Shader',
      code: shaderCode,
    });

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Mipmap Generation Bind Group Layout',
      entries: [
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
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
      ],
    });

    // Create compute pipeline
    this.computePipeline = this.device.createComputePipeline({
      label: 'Mipmap Generation Pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    this.isInitialized = true;
  }

  generateMipmapsForCubemap(texture: GPUTexture, mipLevelCount: number): void {
    if (!this.isInitialized) {
      throw new Error('MipmapGenerator not initialized');
    }

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
        const bindGroup = this.device.createBindGroup({
          label: `Mipmap Generation Face ${face} Level ${mipLevel}`,
          layout: this.bindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: sourceView,
            },
            {
              binding: 1,
              resource: destView,
            },
          ],
        });

        // Dispatch compute shader
        const computePass = commandEncoder.beginComputePass({
          label: `Mipmap Generation Face ${face} Level ${mipLevel}`,
        });

        computePass.setPipeline(this.computePipeline);
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

  dispose(): void {
    // WebGPU resources are garbage collected automatically
    this.isInitialized = false;
  }
}
