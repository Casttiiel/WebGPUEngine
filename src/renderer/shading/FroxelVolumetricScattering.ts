import { GPUUtils } from '../core/utils/GPUUtils';
import { Technique } from '../resources/Technique';
import { RenderTarget } from '../resources/RenderTarget';
import { Mesh } from '../resources/Mesh';
import { Texture } from '../resources/Texture';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ComputePipelineConfig, PipelineFactory } from '../core/factories/PipelineFactory';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';
import { CameraComponent } from '../../components/render/CameraComponent';

/**
 * Modern Froxel-based Volumetric Scattering System
 * Implements industry-standard volumetric lighting using 3D frustum voxelization.
 * Used in Unreal Engine 5, Unity HDRP, Frostbite, etc.
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

  // Rendering resources
  private densityComputeShader!: GPUShaderModule; // Density compute shader
  private densityComputePipeline!: GPUComputePipeline; // Density compute pipeline

  // Scattering pass resources
  private scatteringComputeShader!: GPUShaderModule; // Scattering compute shader
  private scatteringComputePipeline!: GPUComputePipeline; // Scattering compute pipeline

  // Future phase techniques (commented for now):
  // private lightInjectionTechnique!: Technique;       // Inject light into froxels
  private rayMarchTechnique!: Technique; // Final ray marching with alpha blending (does composite automatically)
  private fullscreenQuadMesh!: Mesh;

  // 3D Textures for froxel data
  private froxelDensityTexture!: GPUTexture; // 3D texture: density per froxel
  private froxelScatteringTexture!: GPUTexture; // 3D texture: scattered light per froxel
  private froxelLightTexture!: GPUTexture; // 3D texture: injected light per froxel

  // 2D Result textures
  private volumetricTarget!: RenderTarget; // Final volumetric result
  private depthSlicesTexture!: GPUTexture; // Z-slice depth values (for reconstruction)

  // Noise texture for density variation
  private noiseTexture!: Texture; // 2D noise texture from assets

  // Static bind groups (textures only - uniforms are created dynamically)
  private densityTexturesBindGroup!: GPUBindGroup;

  // Volumetric parameters (increased for visibility)
  private fogDensity: number = 0.5; // Increased from 0.02
  private scatteringCoeff: number = 1.0; // Increased from 0.1
  private absorptionCoeff: number = 0.2; // Increased from 0.05
  private phaseG: number = 0.2; // Henyey-Greenstein phase function
  private fogHeight: number = 10.0; // Increased from 4.0
  private fogHeightFalloff: number = 0.05; // Decreased from 0.1 (less falloff)
  private intensity: number = 3.0; // Increased from 1.0
  private nearPlane: number = 0.1;
  private farPlane: number = 100.0;

  // Uniform buffers
  private volumetricUniformBuffer!: GPUBuffer; // Volumetric parameters
  private froxelUniformBuffer!: GPUBuffer; // Froxel grid parameters
  private volumetricUniformData: Float32Array;
  private froxelUniformData: Float32Array;

  constructor() {
    this.device = GPUUtils.getDevice();
    this.volumetricUniformData = new Float32Array(16); // 64 bytes aligned
    this.froxelUniformData = new Float32Array(16); // 64 bytes aligned
    this.updateUniforms();
  }

  public async load(): Promise<void> {
    // Initialize compute shaders and pipelines
    await this.initializeComputeShaders();

    // Load ray marching technique (uses alpha blending for automatic compositing)
    this.rayMarchTechnique = await Technique.getAsync('froxel_raymarch.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.noiseTexture = await Texture.getAsync('noiseRGB.jpg');

    // Future phases: Load other techniques and resources
    // this.lightInjectionTechnique = await Technique.get('froxel_light_injection.tech');

    this.createUniformBuffers();

    this.create();

    // Recreate bind groups now that we have all techniques
    this.createBindGroups();
  }

  private async initializeComputeShaders(): Promise<void> {
    // Load density compute shader
    const densityResponse = await ResourceManager.fetch(
      `assets/shaders/froxel_density.compute.wgsl`,
    );
    const densityCode = await densityResponse.text();

    this.densityComputeShader = this.device.createShaderModule({
      label: 'Froxel Density Compute Shader',
      code: densityCode,
    });

    // Load scattering compute shader
    const scatteringResponse = await ResourceManager.fetch(
      `assets/shaders/froxel_scattering.compute.wgsl`,
    );
    const scatteringCode = await scatteringResponse.text();

    this.scatteringComputeShader = this.device.createShaderModule({
      label: 'Froxel Scattering Compute Shader',
      code: scatteringCode,
    });

    // Create compute pipelines
    this.createComputePipelines();
  }

  private createComputePipelines(): void {
    // Create density pipeline layout - 3 bind groups: camera, parameters, textures
    const densityPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_density_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelTexturesLayout(),
      ],
    );

    // Create density compute pipeline
    const densityConfig: ComputePipelineConfig = {
      label: 'Froxel Density Compute Pipeline',
      layout: densityPipelineLayout,
      compute: {
        module: this.densityComputeShader,
        entryPoint: 'main',
      },
    };

    this.densityComputePipeline = PipelineFactory.createComputePipeline(densityConfig);

    // Create scattering pipeline layout - 3 bind groups: camera, parameters, textures
    const scatteringPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_scattering_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelScatteringTexturesLayout(),
      ],
    );

    // Create scattering compute pipeline
    const scatteringConfig: ComputePipelineConfig = {
      label: 'Froxel Scattering Compute Pipeline',
      layout: scatteringPipelineLayout,
      compute: {
        module: this.scatteringComputeShader,
        entryPoint: 'main',
      },
    };

    this.scatteringComputePipeline = PipelineFactory.createComputePipeline(scatteringConfig);
  }

  public create(): void {
    // Create 3D froxel textures
    this.createFroxelTextures();

    // Create depth slices texture (for Z reconstruction)
    this.createDepthSlicesTexture();

    const volumetricWidth = Math.floor(Render.width);
    const volumetricHeight = Math.floor(Render.height);

    this.volumetricTarget = new RenderTarget();
    this.volumetricTarget.createRT(
      'froxel_volumetric_result',
      volumetricWidth,
      volumetricHeight,
      'rgba16float',
      false,
      GPUTextureUsage.STORAGE_BINDING,
    );

    // Create bind groups
    this.createBindGroups();
  }

  private createFroxelTextures(): void {
    const { x, y, z } = this.froxelDimensions;

    // Density texture (R32F - single channel density)
    this.froxelDensityTexture = this.device.createTexture({
      label: 'froxel_density_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'r32float',
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

    // Scattering texture (RGBA16F - final scattered light)
    this.froxelScatteringTexture = this.device.createTexture({
      label: 'froxel_scattering_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createDepthSlicesTexture(): void {
    // Create texture with Z-slice depth values for efficient ray marching
    const depthSlicesData = new Float32Array(this.froxelDimensions.z);

    // Logarithmic distribution for better quality near camera
    for (let i = 0; i < this.froxelDimensions.z; i++) {
      const t = i / (this.froxelDimensions.z - 1);
      // Logarithmic interpolation between near and far planes
      depthSlicesData[i] = this.nearPlane * Math.pow(this.farPlane / this.nearPlane, t);
    }

    this.depthSlicesTexture = this.device.createTexture({
      label: 'froxel_depth_slices',
      size: [this.froxelDimensions.z, 1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Upload depth slice data
    this.device.queue.writeTexture(
      { texture: this.depthSlicesTexture },
      depthSlicesData.buffer,
      { bytesPerRow: this.froxelDimensions.z * 4 },
      [this.froxelDimensions.z, 1, 1],
    );
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
    // Create density textures bind group (group 2) - static since textures don't change
    this.densityTexturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_density_textures_bind_group',
      BindGroupFactory.getFroxelTexturesLayout(),
      [
        {
          binding: 0,
          resource: this.froxelDensityTexture.createView(),
        },
        {
          binding: 1,
          resource: this.noiseTexture.getTextureView()!,
        },
        {
          binding: 2,
          resource: SamplerLibrary.nonFilteringSampler, // Use non-filtering sampler for consistency
        },
      ],
    );
  }

  public updateFroxelData(): void {
    if (!this.isEnabled) {
      return;
    }

    // Update uniforms
    this.updateUniforms();

    // 1. Density Pass: Calculate fog density in each froxel
    this.executeDensityPass();

    // 2. Light Injection Pass: Inject light from light sources into froxels
    //this.executeLightInjectionPass(shadowMapBindGroup, lightBufferBindGroup);

    // 3. Scattering Pass: Propagate light between froxels
    this.executeScatteringPass();
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

    // Create compute-compatible camera bind group
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    const cameraBuffer = camera.getUniformBuffer();

    const cameraBindGroup = BindGroupFactory.createBindGroup(
      'froxel_camera_compute_bind_group',
      BindGroupFactory.getCameraComputeLayout(),
      [
        {
          binding: 0,
          resource: { buffer: cameraBuffer },
        },
      ],
    );

    // Create parameters bind group (froxel + volumetric parameters)
    const parametersBindGroup = BindGroupFactory.createBindGroup(
      'froxel_density_parameters_bind_group',
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

    // Bind all resources (three bind groups: camera, parameters, textures)
    computePass.setBindGroup(0, cameraBindGroup); // Camera uniforms
    computePass.setBindGroup(1, parametersBindGroup); // Froxel + volumetric uniforms
    computePass.setBindGroup(2, this.densityTexturesBindGroup); // Textures

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Phase 2: Inject light from light sources into affected froxels
   */
  // TODO: Implement light injection phase
  // private executeLightInjectionPass(
  //   _shadowMapBindGroup: GPUBindGroup,
  //   _lightBufferBindGroup: GPUBindGroup,
  // ): void {
  //   const commandEncoder = this.device.createCommandEncoder({
  //     label: 'froxel_light_injection_pass',
  //   });

  //   const computePass = commandEncoder.beginComputePass({
  //     label: 'froxel_light_injection_compute',
  //   });

  //   // For each light source, determine which froxels are affected
  //   // and inject light contribution considering shadows

  //   computePass.end();
  //   this.device.queue.submit([commandEncoder.finish()]);
  // }

  /**
   * Phase 3: Propagate scattered light between froxels
   */
  private executeScatteringPass(): void {
    if (!this.scatteringComputePipeline) return;

    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_scattering_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_scattering_compute',
    });

    // Set compute pipeline
    computePass.setPipeline(this.scatteringComputePipeline);

    // Create compute-compatible camera bind group for @group(0)
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    const cameraBuffer = camera.getUniformBuffer();

    const cameraBindGroup = BindGroupFactory.createBindGroup(
      'froxel_scattering_camera_compute_bind_group',
      BindGroupFactory.getCameraComputeLayout(),
      [
        {
          binding: 0,
          resource: { buffer: cameraBuffer },
        },
      ],
    );
    computePass.setBindGroup(0, cameraBindGroup);

    // Create parameters bind group for @group(1) - froxel + volumetric uniforms
    const parametersBindGroup = BindGroupFactory.createBindGroup(
      'froxel_scattering_parameters_bind_group',
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
    computePass.setBindGroup(1, parametersBindGroup);

    // Create textures bind group for @group(2)
    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_scattering_textures_bind_group',
      BindGroupFactory.getFroxelScatteringTexturesLayout(),
      [
        {
          binding: 0,
          resource: this.froxelLightTexture.createView(), // Input: light injection
        },
        {
          binding: 1,
          resource: this.froxelDensityTexture.createView(), // Input: density
        },
        {
          binding: 2,
          resource: this.froxelScatteringTexture.createView(), // Output: scattering
        },
        {
          binding: 3,
          resource: SamplerLibrary.nonFilteringSampler, // Non-filtering sampler
        },
      ],
    );
    computePass.setBindGroup(2, texturesBindGroup);

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Render volumetric effects directly onto the scene target using alpha blending
   * This should be called after deferred rendering is complete
   */
  public renderVolumetrics(sceneTarget: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_volumetrics_pass',
    });

    const renderPass = commandEncoder.beginRenderPass({
      label: 'froxel_volumetrics_render',
      colorAttachments: [
        {
          view: sceneTarget,
          loadOp: 'load', // Keep existing scene content
          storeOp: 'store',
        },
      ],
    });

    // Set ray marching pipeline (uses alpha blending)
    this.rayMarchTechnique.activatePipeline(renderPass);

    // Activate mesh data
    this.fullscreenQuadMesh.activate(renderPass);

    // Get camera buffer from engine (like in compute passes)
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    const cameraUniformBuffer = camera.getUniformBuffer();

    // Create ray marching bind group with actual camera uniforms
    const rayMarchBindGroup = BindGroupFactory.createBindGroup(
      'froxel_raymarch_bind_group_runtime',
      BindGroupFactory.getFroxelUniformsLayout(),
      [
        {
          binding: 0,
          resource: { buffer: cameraUniformBuffer }, // Actual camera uniforms
        },
        {
          binding: 1,
          resource: { buffer: this.froxelUniformBuffer }, // Froxel uniforms
        },
        {
          binding: 2,
          resource: { buffer: this.volumetricUniformBuffer }, // Volumetric uniforms
        },
        {
          binding: 3,
          resource: this.froxelDensityTexture.createView(), // 3D density
        },
        {
          binding: 4,
          resource: this.froxelScatteringTexture.createView(), // 3D scattering
        },
        {
          binding: 5,
          resource: SamplerLibrary.nonFilteringSampler, // Non-filtering sampler for unfilterable textures
        },
      ],
    );

    // Bind froxel data and uniforms
    renderPass.setBindGroup(0, rayMarchBindGroup);
    renderPass.setBindGroup(1, gBufferBindGroup);

    // Render fullscreen quad - alpha blending composites automatically
    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private updateUniforms(): void {
    // Volumetric parameters
    let offset = 0;
    this.volumetricUniformData[offset++] = this.fogDensity;
    this.volumetricUniformData[offset++] = this.scatteringCoeff;
    this.volumetricUniformData[offset++] = this.absorptionCoeff;
    this.volumetricUniformData[offset++] = this.phaseG;

    this.volumetricUniformData[offset++] = this.fogHeight;
    this.volumetricUniformData[offset++] = this.fogHeightFalloff;
    this.volumetricUniformData[offset++] = this.intensity;
    this.volumetricUniformData[offset++] = 0.0; // padding

    // Froxel grid parameters
    offset = 0;
    this.froxelUniformData[offset++] = this.froxelDimensions.x;
    this.froxelUniformData[offset++] = this.froxelDimensions.y;
    this.froxelUniformData[offset++] = this.froxelDimensions.z;
    this.froxelUniformData[offset++] = 0.0; // padding

    this.froxelUniformData[offset++] = this.nearPlane;
    this.froxelUniformData[offset++] = this.farPlane;
    this.froxelUniformData[offset++] = 0.0; // padding
    this.froxelUniformData[offset++] = 0.0; // padding

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
  }

  public renderInMenu(): void {}

  public dispose(): void {
    this.volumetricUniformBuffer?.destroy();
    this.froxelUniformBuffer?.destroy();
    this.froxelDensityTexture?.destroy();
    this.froxelLightTexture?.destroy();
    this.froxelScatteringTexture?.destroy();
    this.depthSlicesTexture?.destroy();
  }

  public isVolumetricEnabled(): boolean {
    return this.isEnabled;
  }
}
