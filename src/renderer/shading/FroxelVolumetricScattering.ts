import { GPUUtils } from '../core/utils/GPUUtils';
import { Technique } from '../resources/Technique';
import { Mesh } from '../resources/Mesh';
import { Texture } from '../resources/Texture';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ComputePipelineConfig, PipelineFactory } from '../core/factories/PipelineFactory';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';
import { CameraComponent } from '../../components/render/CameraComponent';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';

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

  // Ambient light injection pass resources
  private ambientLightInjectionShader!: GPUShaderModule; // Ambient light injection shader
  private ambientLightInjectionPipeline!: GPUComputePipeline; // Ambient light injection pipeline

  // Directional light injection pass resources
  private directionalLightInjectionShader!: GPUShaderModule; // Directional light injection shader
  private directionalLightInjectionPipeline!: GPUComputePipeline; // Directional light injection pipeline

  // Future phase techniques (commented for now):
  // private lightInjectionTechnique!: Technique;       // Inject light into froxels
  private rayMarchTechnique!: Technique; // Final ray marching with alpha blending (does composite automatically)
  private fullscreenQuadMesh!: Mesh;

  // 3D Textures for froxel data
  private froxelDensityTexture!: GPUTexture; // 3D texture: density per froxel
  private froxelLightTexture!: GPUTexture; // 3D texture: injected light per froxel

  // Noise texture for density variation
  private noiseTexture!: Texture; // 2D noise texture from assets

  // Static bind groups (textures only - uniforms are created dynamically)
  private densityTexturesBindGroup!: GPUBindGroup;
  // Buffer y bind group para luz ambiente
  private ambientLightUniformBuffer!: GPUBuffer;
  private ambientLightBindGroup!: GPUBindGroup;

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
    // Crear buffer para luz ambiente (vec3 + f32 = 16 bytes)
    this.ambientLightUniformBuffer = GPUUtils.createBuffer(
      'froxel_ambient_light_uniforms',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
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
    const densityCode = await ResourceManager.loadShader('froxel_density.compute.wgsl');

    this.densityComputeShader = this.device.createShaderModule({
      label: 'Froxel Density Compute Shader',
      code: densityCode,
    });

    // Load ambient light injection compute shader
    const ambientLightCode = await ResourceManager.loadShader(
      'froxel_light_injection_ambient.compute.wgsl',
    );

    this.ambientLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Ambient Light Injection Compute Shader',
      code: ambientLightCode,
    });
    // Load directional light injection compute shader
    const directionalLightCode = await ResourceManager.loadShader(
      'froxel_light_injection_directional.compute.wgsl',
    );

    this.directionalLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Directional Light Injection Compute Shader',
      code: directionalLightCode,
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

    // Create ambient light injection pipeline layout
    // group(0): uniforms (froxelParams, volumetricSettings)
    // group(1): textures (density, storageTexture)
    // group(2): ambient light uniform
    const ambientLightPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_ambient_light_injection_pipeline_layout',
      [
        BindGroupFactory.getFroxelParametersLayout(), // group(0): uniforms
        BindGroupFactory.getAmbientLightInjectionTexturesLayout(), // group(1): textures
        BindGroupFactory.getFroxelAmbientLightParametersLayout(), // group(2): ambient light uniform
      ],
    );

    // Create ambient light injection compute pipeline
    const ambientLightConfig: ComputePipelineConfig = {
      label: 'Froxel Ambient Light Injection Compute Pipeline',
      layout: ambientLightPipelineLayout,
      compute: {
        module: this.ambientLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.ambientLightInjectionPipeline = PipelineFactory.createComputePipeline(ambientLightConfig);

    // Create directional light injection pipeline layout
    const directionalLightPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_directional_light_injection_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getDirectionalLightInjectionTexturesLayout(),
        BindGroupFactory.getDirectionalLightDataLayout(),
      ],
    );

    // Create directional light injection compute pipeline
    const directionalLightConfig: ComputePipelineConfig = {
      label: 'Froxel Directional Light Injection Compute Pipeline',
      layout: directionalLightPipelineLayout,
      compute: {
        module: this.directionalLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.directionalLightInjectionPipeline =
      PipelineFactory.createComputePipeline(directionalLightConfig);
  }

  public create(): void {
    // Create 3D froxel textures
    this.createFroxelTextures();

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

    // Crear bind group para luz ambiente (group 1, binding 2)
    this.ambientLightBindGroup = BindGroupFactory.createBindGroup(
      'froxel_ambient_light_uniforms',
      BindGroupFactory.getFroxelAmbientLightParametersLayout(),
      [{ binding: 0, resource: { buffer: this.ambientLightUniformBuffer } }],
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

    // 2. Ambient Light Injection Pass: Inject ambient light color into froxels
    this.executeAmbientLightInjectionPass();

    // 3. Directional Light Injection Pass: Inject directional light with shadows
    // Note: This pass reads from froxelLightTexture (ambient) and writes to froxelScatteringTexture (final)
    //this.executeDirectionalLightInjectionPass();

    // 4. Point/Spot Light Injection Pass: Inject dynamic lights (TODO)
    //this.executePointLightInjectionPass();
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
   * Phase 2a: Ambient Light Injection - inject ambient/skybox color into froxels
   */
  private executeAmbientLightInjectionPass(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_ambient_light_injection_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_ambient_light_injection_compute',
    });

    // Set compute pipeline
    computePass.setPipeline(this.ambientLightInjectionPipeline);

    // Create parameters bind group
    const parametersBindGroup = BindGroupFactory.createBindGroup(
      'froxel_ambient_light_parameters_bind_group',
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

    // Create textures bind group (@group(1) in shader)
    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_ambient_light_textures_bind_group',
      BindGroupFactory.getAmbientLightInjectionTexturesLayout(),
      [
        {
          binding: 0,
          resource: this.froxelDensityTexture.createView(), // Input: density
        },
        {
          binding: 1,
          resource: this.froxelLightTexture.createView(), // Output: light (not scattering!)
        },
      ],
    );

    // Actualizar buffer de luz ambiente antes de ejecutar el pass
    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    // Suponiendo ambientData.color = [r,g,b], ambientData.intensity = float
    const ambientUniform = new Float32Array([0.7, 0.8, 0.9, ambientData.globalFactor]);
    this.device.queue.writeBuffer(this.ambientLightUniformBuffer, 0, ambientUniform.buffer);

    // Bind all resources
    computePass.setBindGroup(0, parametersBindGroup);
    computePass.setBindGroup(1, texturesBindGroup);
    computePass.setBindGroup(2, this.ambientLightBindGroup);

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Phase 2b: Directional Light Injection - inject directional light with shadow testing into froxels
   */
  private executeDirectionalLightInjectionPass(): void {
    console.log('🔶 EXECUTING DIRECTIONAL LIGHT INJECTION PASS');

    // Get directional light component
    const directionalLightComponent = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList()[0] as DirectionalLightComponent;

    if (!directionalLightComponent || !directionalLightComponent.getHasShadows()) {
      console.log('  ⚠️ No directional light with shadows found, skipping');
      return; // No directional light or no shadows
    }

    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_directional_light_injection_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_directional_light_injection_compute',
    });

    // Set compute pipeline
    computePass.setPipeline(this.directionalLightInjectionPipeline);

    // @group(0): Camera bind group
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    const cameraBuffer = camera.getUniformBuffer();

    const cameraBindGroup = BindGroupFactory.createBindGroup(
      'froxel_directional_light_camera_bind_group',
      BindGroupFactory.getCameraComputeLayout(),
      [
        {
          binding: 0,
          resource: { buffer: cameraBuffer },
        },
      ],
    );

    // @group(1): Parameters bind group (froxel + volumetric)
    const parametersBindGroup = BindGroupFactory.createBindGroup(
      'froxel_directional_light_parameters_bind_group',
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

    // @group(2): Textures bind group (density input, light input, light output)
    // Ahora tanto la luz ambiente como la direccional se acumulan en froxelLightTexture
    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_directional_light_textures_bind_group',
      BindGroupFactory.getDirectionalLightInjectionTexturesLayout(),
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
          resource: this.froxelLightTexture.createView(), // Output: luz acumulada
        },
      ],
    );

    // @group(3): Directional light data bind group (uniforms + shadow map + sampler)
    const directionalLightDataBindGroup = BindGroupFactory.createBindGroup(
      'froxel_directional_light_data_bind_group',
      BindGroupFactory.getDirectionalLightDataLayout(),
      [
        {
          binding: 0,
          resource: { buffer: directionalLightComponent.getUniformBuffer() }, // DirectionalLightUniforms
        },
        {
          binding: 1,
          resource: directionalLightComponent.getShadowDepthView(0), // Shadow map (cascade 0)
        },
        {
          binding: 2,
          resource: directionalLightComponent.getShadowSampler(), // Comparison sampler
        },
      ],
    );

    // Bind all resources
    computePass.setBindGroup(0, cameraBindGroup);
    computePass.setBindGroup(1, parametersBindGroup);
    computePass.setBindGroup(2, texturesBindGroup);
    computePass.setBindGroup(3, directionalLightDataBindGroup);

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
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
   * Render volumetric effects directly onto the scene target using alpha blending
   * This should be called after deferred rendering is complete
   */
  public renderVolumetrics(sceneTarget: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const commandEncoder = render.getCommandEncoder(); // Use global command encoder

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
          resource: this.froxelLightTexture.createView(), // 3D luz acumulada
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
    // No submit here - the global command encoder will be submitted at end of frame
  }

  private updateUniforms(): void {
    // Sync scattering coefficient with ambient light settings for consistency
    const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
    this.scatteringCoeff = ambientData.globalFactor * ambientData.diffuseFactor;

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
  }

  public isVolumetricEnabled(): boolean {
    return this.isEnabled;
  }
}
