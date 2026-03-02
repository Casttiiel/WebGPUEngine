import { ResourceManager } from '../../../core/engine/ResourceManager';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { ComputePipelineConfig, PipelineFactory } from '../factories/PipelineFactory';
import { GPUUtils } from '../utils/GPUUtils';
import { ShaderPreprocessor } from './ShaderPreprocessor';

export class MipmapGenerator {
  private static instance: MipmapGenerator | null = null;

  private device!: GPUDevice;
  private baseShaderCode!: string;
  private pipelines: Map<GPUTextureFormat, GPUComputePipeline> = new Map();
  private pipelinePromises: Map<GPUTextureFormat, Promise<GPUComputePipeline>> = new Map();
  private bindGroupLayouts: Map<GPUTextureFormat, GPUBindGroupLayout> = new Map();
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor for singleton pattern
  }

  public static getInstance(): MipmapGenerator {
    if (!MipmapGenerator.instance) {
      MipmapGenerator.instance = new MipmapGenerator();
    }
    return MipmapGenerator.instance;
  }

  public static destroyInstance(): void {
    if (MipmapGenerator.instance) {
      MipmapGenerator.instance.destroy();
      MipmapGenerator.instance = null;
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.device = GPUUtils.getDevice();
      this.baseShaderCode = await ShaderPreprocessor.preprocessShader('utility/generate_mipmap.wgsl');
      this.isInitialized = true;
    })();
    return this.initPromise;
  }

  private createShaderForFormat(format: GPUTextureFormat): string {
    // Replace the hardcoded format in the shader with the actual format
    return this.baseShaderCode.replace('rgba16float', format);
  }

  /**
   * Pre-warms pipelines for known texture formats.
   * Call this as early as possible so GPU compilation overlaps with I/O work.
   */
  public async preWarm(formats: GPUTextureFormat[]): Promise<void> {
    await this.initialize();
    await Promise.all(formats.map((f) => this.getOrCreatePipeline(f)));
  }

  private async getOrCreatePipeline(format: GPUTextureFormat): Promise<{
    pipeline: GPUComputePipeline;
    bindGroupLayout: GPUBindGroupLayout;
  }> {
    if (!this.pipelines.has(format)) {
      // Deduplicate concurrent compile requests for the same format
      if (!this.pipelinePromises.has(format)) {
        const shaderCode = this.createShaderForFormat(format);
        const shaderModule = this.device.createShaderModule({
          label: `Mipmap Generation Compute Shader ${format}`,
          code: shaderCode,
        });

        const bindGroupLayout = BindGroupFactory.getLayout(`mipmap_generation_${format}`, [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            texture: { viewDimension: '2d', sampleType: 'float' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format, viewDimension: '2d' },
          },
        ]);
        this.bindGroupLayouts.set(format, bindGroupLayout);

        const computeConfig: ComputePipelineConfig = {
          label: `Mipmap Generation Pipeline ${format}`,
          layout: PipelineFactory.createPipelineLayout(
            `mipmap_generation_pipeline_layout_${format}`,
            [bindGroupLayout],
          ),
          compute: { module: shaderModule, entryPoint: 'main' },
        };

        // Async compile — does not block the main thread
        const promise = this.device
          .createComputePipelineAsync(computeConfig)
          .then((pipeline) => {
            this.pipelines.set(format, pipeline);
            return pipeline;
          });
        this.pipelinePromises.set(format, promise);
      }
      await this.pipelinePromises.get(format)!;
    }

    return {
      pipeline: this.pipelines.get(format)!,
      bindGroupLayout: this.bindGroupLayouts.get(format)!,
    };
  }

  public async generateMipmapsForCubemap(
    texture: GPUTexture,
    mipLevelCount: number,
  ): Promise<void> {
    // Ensure we have a valid device before proceeding
    await this.ensureValidDevice();

    if (!this.isInitialized) {
      throw new Error('MipmapGenerator not initialized');
    }

    // Get pipeline and bind group layout for this texture format
    const { pipeline, bindGroupLayout } = await this.getOrCreatePipeline(texture.format);

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

  public async generateMipmapsFor2D(texture: GPUTexture, mipLevelCount: number): Promise<void> {
    // Ensure we have a valid device before proceeding
    await this.ensureValidDevice();

    if (!this.isInitialized) {
      throw new Error('MipmapGenerator not initialized');
    }

    // Get pipeline and bind group layout for this texture format
    const { pipeline, bindGroupLayout } = await this.getOrCreatePipeline(texture.format);

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

  public dispose(): void {
    this.destroy();
  }

  public destroy(): void {
    console.log('Destroying MipmapGenerator...');

    // Clear all cached pipelines and bind group layouts
    this.pipelines.clear();
    this.pipelinePromises.clear();
    this.bindGroupLayouts.clear();

    // Clear device reference
    this.device = null!;
    this.baseShaderCode = null!;
    this.initPromise = null;

    // Mark as not initialized to force re-initialization
    this.isInitialized = false;

    console.log('MipmapGenerator destroyed.');
  }

  /**
   * Check if the current device is still valid and re-initialize if needed
   */
  private async ensureValidDevice(): Promise<void> {
    const currentDevice = GPUUtils.getDevice();
    if (!this.isInitialized || this.device !== currentDevice) {
      console.log('MipmapGenerator device invalid, re-initializing...');
      this.initPromise = null; // force fresh init
      await this.initialize();
    }
  }
}
