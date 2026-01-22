import { GPUUtils } from '../core/utils/GPUUtils';
import { Technique } from '../resources/Technique';
import { Mesh } from '../resources/Mesh';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ComputePipelineConfig, PipelineFactory } from '../core/factories/PipelineFactory';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { Texture } from '../resources/Texture';

/**
 * Modern Froxel-based Volumetric Scattering System
 * Implements industry-standard volumetric lighting using 3D frustum voxelization.
 */
export class FroxelVolumetricScattering {
  private device: GPUDevice;
  private isEnabled: boolean = true;

  // Froxel grid dimensions
  private froxelDimensions = {
    x: 160, // Width slices
    y: 90, // Height slices
    z: 64, // Depth slices (logarithmic distribution)
  };

  private densityComputeShader!: GPUShaderModule;
  private densityComputePipeline!: GPUComputePipeline;

  private volumetricIntegrationComputeShader!: GPUShaderModule;
  private volumetricIntegrationComputePipeline!: GPUComputePipeline;

  private rayMarchTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  // 3D Textures for froxel data
  private froxelDensityTexture!: GPUTexture;
  private froxelIntegratedTexture!: GPUTexture;
  private froxelLightTexture!: GPUTexture;
  private froxelLightTempTexture!: GPUTexture;

  // Static bind groups (textures only - uniforms are created dynamically)
  private densityTexturesBindGroup!: GPUBindGroup;

  private fogDensity: number = 1.0;
  private scatteringCoeff: number = 2.0;
  private absorptionCoeff: number = 3.0;
  private stepSize: number = 0.1;
  private nearPlane: number = 0.1;
  private farPlane: number = 100.0;

  // Uniform buffers
  private volumetricUniformBuffer!: GPUBuffer;
  private froxelUniformBuffer!: GPUBuffer;
  private volumetricUniformData: Float32Array;
  private froxelUniformData: Float32Array;

  private parametersBindGroup!: GPUBindGroup;

  constructor() {
    this.device = GPUUtils.getDevice();
    this.volumetricUniformData = new Float32Array(16);
    this.froxelUniformData = new Float32Array(16);
  }

  public async load(): Promise<void> {
    await Texture.getAsync('noiseRGB.jpg'); //TODO REMOVE
    await this.initializeComputeShaders();

    this.rayMarchTechnique = await Technique.getAsync('froxel_raymarch.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.createUniformBuffers();

    this.create();

    this.createBindGroups();
  }

  private async initializeComputeShaders(): Promise<void> {
    const densityCode = await ResourceManager.loadShader('froxel_density.compute.wgsl');

    this.densityComputeShader = this.device.createShaderModule({
      label: 'Froxel Density Compute Shader',
      code: densityCode,
    });

    const volumetricIntegrationCode = await ResourceManager.loadShader(
      'froxel_volumetric_integration.compute.wgsl',
    );

    this.volumetricIntegrationComputeShader = this.device.createShaderModule({
      label: 'Froxel Volumetric Integration Compute Shader',
      code: volumetricIntegrationCode,
    });

    this.createComputePipelines();
  }

  private createComputePipelines(): void {
    const densityPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_density_pipeline_layout',
      [
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelDensityTexturesLayout(),
      ],
    );

    const densityConfig: ComputePipelineConfig = {
      label: 'Froxel Density Compute Pipeline',
      layout: densityPipelineLayout,
      compute: {
        module: this.densityComputeShader,
        entryPoint: 'main',
      },
    };

    this.densityComputePipeline = PipelineFactory.createComputePipeline(densityConfig);

    const volumetricIntegrationPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_volumetric_integration_pipeline_layout',
      [
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelVolumetrictIntegrationLayout(),
      ],
    );

    const volumetricIntegrationConfig: ComputePipelineConfig = {
      label: 'Froxel Volumetric Integration Compute Pipeline',
      layout: volumetricIntegrationPipelineLayout,
      compute: {
        module: this.volumetricIntegrationComputeShader,
        entryPoint: 'main',
      },
    };

    this.volumetricIntegrationComputePipeline = PipelineFactory.createComputePipeline(
      volumetricIntegrationConfig,
    );
  }

  public create(): void {
    this.createFroxelTextures();
    this.createBindGroups();
  }

  private createFroxelTextures(): void {
    const { x, y, z } = this.froxelDimensions;

    // Density texture (R32F - single channel density)
    this.froxelDensityTexture = this.device.createTexture({
      label: 'froxel_density_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'rg32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Light injection texture (RGBA16F - light contribution per froxel)
    this.froxelLightTexture = this.device.createTexture({
      label: 'froxel_light_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.froxelLightTempTexture = this.device.createTexture({
      label: 'froxel_light_3d_temp',
      size: [x, y, z],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.froxelIntegratedTexture = this.device.createTexture({
      label: 'froxel_integrated_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createUniformBuffers(): void {
    this.volumetricUniformBuffer = GPUUtils.createBuffer(
      'froxel_volumetric_uniforms',
      this.volumetricUniformData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.froxelUniformBuffer = GPUUtils.createBuffer(
      'froxel_grid_uniforms',
      this.froxelUniformData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
  }

  private createBindGroups(): void {
    this.densityTexturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_density_textures_bind_group',
      BindGroupFactory.getFroxelDensityTexturesLayout(),
      [
        {
          binding: 0,
          resource: this.froxelDensityTexture.createView(),
        },
      ],
    );
  }

  public updateFroxelData(): void {
    if (!this.isEnabled) {
      return;
    }

    this.updateUniforms();

    this.executeDensityPass();

    this.executeVolumetrictIntegrationPass();
  }

  private executeDensityPass(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_density_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_density_compute',
    });

    // Set compute pipeline
    computePass.setPipeline(this.densityComputePipeline);
    computePass.setBindGroup(0, this.parametersBindGroup); // Froxel + volumetric uniforms
    computePass.setBindGroup(1, this.densityTexturesBindGroup); // Textures

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  private executeVolumetrictIntegrationPass(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_volumetrict_integration_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_volumetrict_integration_compute',
    });

    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_directional_light_textures_bind_group',
      BindGroupFactory.getFroxelVolumetrictIntegrationLayout(),
      [
        {
          binding: 0,
          resource: this.froxelDensityTexture.createView(), // Input: density (unfilterable)
        },
        {
          binding: 1,
          resource: this.froxelLightTexture.createView(), // Input/output: luz acumulada
        },
        {
          binding: 2,
          resource: this.froxelIntegratedTexture.createView(), // Output:integrated
        },
        {
          binding: 3,
          resource: SamplerLibrary.nonFilteringSampler, // Non-filtering sampler for unfilterable textures
        },
      ],
    );

    computePass.setPipeline(this.volumetricIntegrationComputePipeline);
    computePass.setBindGroup(0, this.parametersBindGroup); // Froxel + volumetric uniforms
    computePass.setBindGroup(1, texturesBindGroup); // Textures

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(1);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  public renderVolumetrics(sceneTarget: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const commandEncoder = render.getCommandEncoder();

    const renderPass = commandEncoder.beginRenderPass({
      label: 'froxel_volumetrics_render',
      colorAttachments: [
        {
          view: sceneTarget,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    this.rayMarchTechnique.activatePipeline(renderPass);

    this.fullscreenQuadMesh.activate(renderPass);

    const rayMarchBindGroup = BindGroupFactory.createBindGroup(
      'froxel_raymarch_bind_group_runtime',
      BindGroupFactory.getFroxelUniformsLayout(),
      [
        {
          binding: 0,
          resource: { buffer: this.froxelUniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.volumetricUniformBuffer },
        },
        {
          binding: 2,
          resource: this.froxelIntegratedTexture.createView(),
        },
        {
          binding: 3,
          resource: SamplerLibrary.simpleSampler,
        },
      ],
    );

    renderPass.setBindGroup(0, rayMarchBindGroup);
    renderPass.setBindGroup(1, gBufferBindGroup);

    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }

  private updateUniforms(): void {
    // Volumetric parameters
    let offset = 0;
    this.volumetricUniformData[offset++] = this.fogDensity;
    this.volumetricUniformData[offset++] = this.scatteringCoeff;
    this.volumetricUniformData[offset++] = this.absorptionCoeff;
    this.volumetricUniformData[offset++] = this.stepSize;

    // Froxel grid parameters
    offset = 0;
    this.froxelUniformData[offset++] = this.froxelDimensions.x;
    this.froxelUniformData[offset++] = this.froxelDimensions.y;
    this.froxelUniformData[offset++] = this.froxelDimensions.z;
    this.froxelUniformData[offset++] = this.nearPlane;
    this.froxelUniformData[offset++] = this.farPlane;

    // Upload to GPU
    if (this.volumetricUniformBuffer) {
      this.device.queue.writeBuffer(
        this.volumetricUniformBuffer,
        0,
        this.volumetricUniformData.buffer,
      );
    }
    if (this.froxelUniformBuffer) {
      this.device.queue.writeBuffer(this.froxelUniformBuffer, 0, this.froxelUniformData.buffer);
    }

    if (!this.parametersBindGroup && this.froxelUniformBuffer && this.volumetricUniformBuffer) {
      // Create parameters bind group (froxel + volumetric parameters)
      this.parametersBindGroup = BindGroupFactory.createBindGroup(
        'froxel_parameters_bind_group',
        BindGroupFactory.getFroxelParametersLayout(),
        [
          {
            binding: 0,
            resource: { buffer: this.froxelUniformBuffer },
          },
          {
            binding: 1,
            resource: { buffer: this.volumetricUniformBuffer },
          },
        ],
      );
    }
  }

  public renderInMenu(): void {}

  public dispose(): void {
    this.volumetricUniformBuffer?.destroy();
    this.froxelUniformBuffer?.destroy();
    this.froxelDensityTexture?.destroy();
    this.froxelIntegratedTexture?.destroy();
    this.froxelLightTexture?.destroy();
    this.froxelLightTempTexture?.destroy();
  }

  public isVolumetricEnabled(): boolean {
    return this.isEnabled;
  }
}
