import { GPUUtils } from '../core/utils/GPUUtils';
import { Technique } from '../resources/Technique';
import { Mesh } from '../resources/Mesh';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ComputePipelineConfig, PipelineFactory } from '../core/factories/PipelineFactory';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { Texture } from '../resources/Texture';
import { Engine } from '../../core/engine/Engine';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';

/**
 * Modern Froxel-based Volumetric Scattering System
 * Implements industry-standard volumetric lighting using 3D frustum voxelization.
 */
export class FroxelVolumetricScattering {
  private device: GPUDevice;
  private isEnabled: boolean = true;

  // Froxel grid dimensions
  private froxelDimensions = {
    x: 360, // Width slices
    y: 240, // Height slices
    z: 256, // Depth slices (logarithmic distribution)
  };

  private densityComputeShader!: GPUShaderModule;
  private densityComputePipeline!: GPUComputePipeline;

  private volumetricIntegrationComputeShader!: GPUShaderModule;
  private volumetricIntegrationComputePipeline!: GPUComputePipeline;

  private ambientLightInjectionShader!: GPUShaderModule;
  private ambientLightInjectionPipeline!: GPUComputePipeline;

  private pointLightInjectionShader!: GPUShaderModule;
  private pointLightInjectionPipeline!: GPUComputePipeline;

  private rayMarchTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  // 3D Textures for froxel data
  private froxelDensityTexture!: GPUTexture;
  private froxelIntegratedTexture!: GPUTexture;
  private froxelLightTexture!: GPUTexture;
  private froxelLightTempTexture!: GPUTexture;
  private noiseTexture!: Texture;

  // Static bind groups (textures only - uniforms are created dynamically)
  private densityTexturesBindGroup!: GPUBindGroup;
  private cameraBindGroup!: GPUBindGroup;

  private fogDensity: number = 0.02;
  private scatteringCoeff: number = 1.0;
  private absorptionCoeff: number = 0.2; // Aumentado para god rays más definidos (antes 1.5)
  private multipleScatteringBoost: number = 1.3; // Energy compensation for multiple scattering (1.1-1.6)
  private anisotropy: number = 0.9; // Phase function g parameter (0.75-0.9 for god rays)
  private fogBaseHeight: number = 0.0; // Height fog base (world Y)
  private fogLayerHeight: number = 30.0; // Uniform fog layer thickness
  private fogFalloff: number = 0.08; // Exponential falloff above layer
  private ambientVolumetricIntensity: number = 0.0; // Ambient contribution to volumetric (keep low, 0.0-0.1)
  private nearPlane: number = 0.1;
  private farPlane: number = 100.0;

  // Uniform buffers
  private volumetricUniformBuffer!: GPUBuffer;
  private froxelUniformBuffer!: GPUBuffer;
  private ambientUniformBuffer!: GPUBuffer;
  private volumetricUniformData: Float32Array;
  private froxelUniformData: Float32Array;

  private parametersBindGroup!: GPUBindGroup;
  private noiseTextureBindGroup!: GPUBindGroup;

  constructor() {
    this.device = GPUUtils.getDevice();
    this.volumetricUniformData = new Float32Array(16);
    this.froxelUniformData = new Float32Array(16);
  }

  public async load(): Promise<void> {
    this.noiseTexture = await Texture.getAsync('noiseRGBTileable.jpg');
    await this.initializeComputeShaders();

    this.rayMarchTechnique = await Technique.getAsync('volumetric/froxel_raymarch.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.createUniformBuffers();

    this.create();

    this.createBindGroups();
  }

  private async initializeComputeShaders(): Promise<void> {
    const densityCode = await ResourceManager.loadShader('volumetric/froxel_density.compute.wgsl');

    this.densityComputeShader = this.device.createShaderModule({
      label: 'Froxel Density Compute Shader',
      code: densityCode,
    });

    const volumetricIntegrationCode = await ResourceManager.loadShader(
      'volumetric/froxel_volumetric_integration.compute.wgsl',
    );

    this.volumetricIntegrationComputeShader = this.device.createShaderModule({
      label: 'Froxel Volumetric Integration Compute Shader',
      code: volumetricIntegrationCode,
    });

    const ambientLightInjectionCode = await ResourceManager.loadShader(
      'volumetric/froxel_light_injection_ambient.compute.wgsl',
    );

    this.ambientLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Ambient Light Injection Compute Shader',
      code: ambientLightInjectionCode,
    });

    const pointLightInjectionCode = await ResourceManager.loadShader(
      'volumetric/froxel_light_injection_point.compute.wgsl',
    );

    this.pointLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Point Light Injection Compute Shader',
      code: pointLightInjectionCode,
    });

    this.createComputePipelines();
  }

  private createComputePipelines(): void {
    const densityPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_density_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelDensityTexturesLayout(),
        BindGroupFactory.getSingleTextureComputeLayout(),
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
        BindGroupFactory.getFroxelVolumetricIntegrationLayout(),
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

    const ambientLightInjectionPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_ambient_light_injection_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelAmbientLayout(),
        BindGroupFactory.getDirectionalLightDataLayout(),
      ],
    );

    const ambientLightConfig: ComputePipelineConfig = {
      label: 'Froxel Ambient Light Injection Compute Pipeline',
      layout: ambientLightInjectionPipelineLayout,
      compute: {
        module: this.ambientLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.ambientLightInjectionPipeline = PipelineFactory.createComputePipeline(ambientLightConfig);

    const pointLightInjectionPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_point_light_injection_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelPointTexturesLayout(),
        BindGroupFactory.getFroxelLightParametersLayout(),
      ],
    );

    const pointLightConfig: ComputePipelineConfig = {
      label: 'Froxel Point Light Injection Compute Pipeline',
      layout: pointLightInjectionPipelineLayout,
      compute: {
        module: this.pointLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.pointLightInjectionPipeline = PipelineFactory.createComputePipeline(pointLightConfig);
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

    this.ambientUniformBuffer = GPUUtils.createBuffer(
      'froxel_ambient_light_uniforms',
      16,
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

    this.executeAmbientLightInjectionPass();

    this.executePointLightInjectionPass();

    this.executeVolumetricIntegrationPass();
  }

  private executeDensityPass(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_density_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_density_compute',
    });

    if (!this.cameraBindGroup || true) {
      const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
      const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
      const camera = cameraComponent.getCamera();
      const cameraBuffer = camera.getUniformBuffer();

      this.cameraBindGroup = BindGroupFactory.createBindGroup(
        'froxel_directional_light_camera_bind_group',
        BindGroupFactory.getCameraComputeLayout(),
        [
          {
            binding: 0,
            resource: { buffer: cameraBuffer },
          },
        ],
      );
    }
    if (!this.noiseTextureBindGroup) {
      this.noiseTextureBindGroup = BindGroupFactory.createBindGroup(
        'froxel_directional_light_noise_texture_bind_group',
        BindGroupFactory.getSingleTextureComputeLayout(),
        [
          {
            binding: 0,
            resource: this.noiseTexture.getTextureView()!,
          },
          {
            binding: 1,
            resource: SamplerLibrary.simpleSampler,
          },
        ],
      );
    }

    // Set compute pipeline
    computePass.setPipeline(this.densityComputePipeline);
    computePass.setBindGroup(0, this.cameraBindGroup);
    computePass.setBindGroup(1, this.parametersBindGroup); // Froxel + volumetric uniforms
    computePass.setBindGroup(2, this.densityTexturesBindGroup); // Textures
    computePass.setBindGroup(3, this.noiseTextureBindGroup); // Textures

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  private executeVolumetricIntegrationPass(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_volumetrict_integration_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_volumetrict_integration_compute',
    });

    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_volumetrict_integration_textures_bind_group',
      BindGroupFactory.getFroxelVolumetricIntegrationLayout(),
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

  private executeAmbientLightInjectionPass(): void {
    const directionalLightComponent = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList()[0] as DirectionalLightComponent;

    if (!directionalLightComponent || !directionalLightComponent.getHasShadows()) {
      console.log('  ⚠️ No directional light with shadows found, skipping');
      return; // No directional light or no shadows
    }

    const commandEncoder = this.device.createCommandEncoder({
      label: 'froxel_ambient_light_injection_pass',
    });

    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_ambient_light_injection_compute',
    });

    // Set compute pipeline
    computePass.setPipeline(this.ambientLightInjectionPipeline);

    // Create textures bind group (@group(1) in shader)
    const texturesBindGroup = BindGroupFactory.createBindGroup(
      'froxel_ambient_light_textures_bind_group',
      BindGroupFactory.getAmbientLightInjectionTexturesLayout(),
      [
        {
          binding: 0,
          resource: this.froxelLightTexture.createView(),
        },
        {
          binding: 1,
          resource: {
            buffer: this.ambientUniformBuffer,
          },
        },
      ],
    );

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
    computePass.setBindGroup(0, this.cameraBindGroup);
    computePass.setBindGroup(1, this.parametersBindGroup);
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

  private executePointLightInjectionPass(): void {
    const pointLightManager = Engine.getEntities().getObjectManagerByName('point_light');
    if (!pointLightManager) return;
    const pointLights = pointLightManager.getList() as PointLightComponent[];

    // Camera and parameter bind groups (no cambian entre luces)
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();
    const cameraBuffer = camera.getUniformBuffer();
    const cameraBindGroup = BindGroupFactory.createBindGroup(
      'froxel_point_light_camera_bind_group',
      BindGroupFactory.getCameraComputeLayout(),
      [{ binding: 0, resource: { buffer: cameraBuffer } }],
    );
    const parametersBindGroup = BindGroupFactory.createBindGroup(
      'froxel_point_light_parameters_bind_group',
      BindGroupFactory.getFroxelParametersLayout(),
      [
        { binding: 0, resource: { buffer: this.froxelUniformBuffer } },
        { binding: 1, resource: { buffer: this.volumetricUniformBuffer } },
      ],
    );

    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    let lightRead = this.froxelLightTexture;
    let lightWrite = this.froxelLightTempTexture;

    for (const pointLightComponent of pointLights) {
      if (!pointLightComponent.isVisible()) {
        continue;
      }
      const commandEncoder = this.device.createCommandEncoder({
        label: 'froxel_point_light_injection_pass',
      });
      const computePass = commandEncoder.beginComputePass({
        label: 'froxel_point_light_injection_compute',
      });

      computePass.setPipeline(this.pointLightInjectionPipeline);

      // Bind groups comunes
      computePass.setBindGroup(0, cameraBindGroup);
      computePass.setBindGroup(1, parametersBindGroup);

      const texturesBindGroup = BindGroupFactory.createBindGroup(
        'froxel_point_light_textures_bind_group',
        BindGroupFactory.getFroxelPointTexturesLayout(),
        [
          { binding: 0, resource: this.froxelDensityTexture.createView() },
          { binding: 1, resource: lightRead.createView() },
          { binding: 2, resource: lightWrite.createView() },
        ],
      );
      computePass.setBindGroup(2, texturesBindGroup);

      // Bind group específico de la luz
      const pointLightDataBindGroup = BindGroupFactory.createBindGroup(
        'froxel_point_light_data_bind_group',
        BindGroupFactory.getFroxelLightParametersLayout(),
        [{ binding: 0, resource: { buffer: pointLightComponent.getUniformBuffer() } }],
      );
      computePass.setBindGroup(3, pointLightDataBindGroup);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
      computePass.end();
      this.device.queue.submit([commandEncoder.finish()]);

      const tmp = lightRead;
      lightRead = lightWrite;
      lightWrite = tmp;
    }

    this.froxelLightTexture = lightRead;
    this.froxelLightTempTexture = lightWrite;
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
    this.volumetricUniformData[offset++] = this.multipleScatteringBoost;
    this.volumetricUniformData[offset++] = this.anisotropy;
    this.volumetricUniformData[offset++] = this.fogBaseHeight;
    this.volumetricUniformData[offset++] = this.fogLayerHeight;
    this.volumetricUniformData[offset++] = this.fogFalloff;
    this.volumetricUniformData[offset++] = this.ambientVolumetricIntensity;

    // Froxel grid parameters
    offset = 0;
    this.froxelUniformData[offset++] = this.froxelDimensions.x;
    this.froxelUniformData[offset++] = this.froxelDimensions.y;
    this.froxelUniformData[offset++] = this.froxelDimensions.z;
    this.froxelUniformData[offset++] = 0.0; // Padding
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

    if (this.ambientUniformBuffer) {
      const ambientData = Engine.getEnvironmentManager().getAmbientLightData();
      const ambientUniform = new Float32Array([0.7, 0.8, 0.9, ambientData.globalFactor]);
      this.device.queue.writeBuffer(this.ambientUniformBuffer, 0, ambientUniform.buffer);
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

  public renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // Create/get the Volumetrics folder
    if (!gui.beginWindow('Volumetrics', true)) return;

    // Access the folder from GUIManager's internal map
    const guiManager = gui as any;
    const folder = guiManager.folders?.get('Volumetrics');

    if (!folder) {
      gui.endWindow();
      return;
    }

    // Volumetric parameters with automatic UI updates
    folder.add(this, 'fogDensity', 0.001, 0.02).name('Fog Density').listen();

    folder.add(this, 'scatteringCoeff', 0.0, 2.0).name('Scattering Coeff').listen();

    folder.add(this, 'absorptionCoeff', 0.0, 5.0).name('Absorption Coeff').listen();

    folder.add(this, 'multipleScatteringBoost', 1.0, 2.0).name('MS Boost').listen();

    folder.add(this, 'anisotropy', 0.0, 0.99).name('Anisotropy (g)').listen();

    folder.add(this, 'fogBaseHeight', -10.0, 10.0).name('Fog Base Height').listen();

    folder.add(this, 'fogLayerHeight', 1.0, 50.0).name('Fog Layer Height').listen();

    folder.add(this, 'fogFalloff', 0.0, 1.0).name('Fog Falloff').listen();

    folder.add(this, 'ambientVolumetricIntensity', 0.0, 0.2).name('Ambient Volumetric').listen();

    folder.add(this, 'nearPlane', 0.01, 1.0).name('Near Plane').listen();

    folder.add(this, 'farPlane', 10.0, 200.0).name('Far Plane').listen();

    gui.endWindow();
  }

  public getFogDensity(): number {
    return this.fogDensity;
  }
  public setFogDensity(value: number): void {
    this.fogDensity = value;
  }

  public getScatteringCoeff(): number {
    return this.scatteringCoeff;
  }
  public setScatteringCoeff(value: number): void {
    this.scatteringCoeff = value;
  }

  public getAbsorptionCoeff(): number {
    return this.absorptionCoeff;
  }
  public setAbsorptionCoeff(value: number): void {
    this.absorptionCoeff = value;
  }

  public getMultipleScatteringBoost(): number {
    return this.multipleScatteringBoost;
  }
  public setMultipleScatteringBoost(value: number): void {
    this.multipleScatteringBoost = value;
  }

  public getAnisotropy(): number {
    return this.anisotropy;
  }
  public setAnisotropy(value: number): void {
    this.anisotropy = value;
  }

  public getFogBaseHeight(): number {
    return this.fogBaseHeight;
  }
  public setFogBaseHeight(value: number): void {
    this.fogBaseHeight = value;
  }

  public getFogLayerHeight(): number {
    return this.fogLayerHeight;
  }
  public setFogLayerHeight(value: number): void {
    this.fogLayerHeight = value;
  }

  public getFogFalloff(): number {
    return this.fogFalloff;
  }
  public setFogFalloff(value: number): void {
    this.fogFalloff = value;
  }

  public getAmbientVolumetricIntensity(): number {
    return this.ambientVolumetricIntensity;
  }
  public setAmbientVolumetricIntensity(value: number): void {
    this.ambientVolumetricIntensity = value;
  }

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
