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
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { RenderTarget } from '../resources/RenderTarget';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { Wind } from '../../core/engine/Wind';
import { FogVolumeComponent } from '../../components/vfx/FogVolumeComponent';

/**
 * Modern Froxel-based Volumetric Scattering System
 * Implements industry-standard volumetric lighting using 3D frustum voxelization.
 */
export class FroxelVolumetricScattering {
  private device: GPUDevice;
  private isEnabled: boolean = true;
  private _editorFolder: any = null;

  // Maps sky UV speed (0.08/s) → ~1.2 world-units/s froxel noise (same as original hardcoded wind magnitude)
  private static readonly FROXEL_WORLD_SPEED_SCALE = 15.0;

  // Froxel grid dimensions — half-res relative to the previous 240×135×128.
  // Smaller grid + temporal blue-noise dithering (already in raymarch shader)
  // lets TAA reconstruct detail without the cost of the full-res grid.
  private froxelDimensions = {
    x: 160,
    y: 90,
    z: 64,
  };

  private densityComputeShader!: GPUShaderModule;
  private densityComputePipeline!: GPUComputePipeline;

  private volumetricIntegrationComputeShader!: GPUShaderModule;
  private volumetricIntegrationComputePipeline!: GPUComputePipeline;

  private selfOcclusionShader!: GPUShaderModule;
  private selfOcclusionPipeline!: GPUComputePipeline;

  private directionalLightInjectionShader!: GPUShaderModule;
  private directionalLightInjectionPipeline!: GPUComputePipeline;

  private pointLightInjectionShader!: GPUShaderModule;
  private pointLightInjectionPipeline!: GPUComputePipeline;

  private spotLightInjectionShader!: GPUShaderModule;
  private spotLightInjectionPipeline!: GPUComputePipeline;

  private rayMarchTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  // 3D Textures for froxel data
  private froxelDensityTexture!: GPUTexture;
  private froxelDensityTextureView!: GPUTextureView;
  private froxelIntegratedTexture!: GPUTexture;
  private froxelIntegratedTextureView!: GPUTextureView;
  private froxelLightTexture!: GPUTexture;
  private froxelLightTextureView!: GPUTextureView;
  private froxelLightTempTexture!: GPUTexture;
  private froxelLightTempTextureView!: GPUTextureView;
  private noiseTexture!: Texture;
  private blueNoiseTexture!: Texture;

  private froxelLightTextureViewA!: GPUTextureView; // Siempre apunta a froxel_light_3d
  private froxelLightTempTextureViewB!: GPUTextureView; // Siempre apunta a froxel_light_3d_temp
  private froxelSelfOcclusionTexture!: GPUTexture;
  private froxelSelfOcclusionTextureView!: GPUTextureView;

  // Static bind groups (textures only - uniforms are created dynamically)
  private densityTexturesBindGroup!: GPUBindGroup;
  private cameraBindGroup!: GPUBindGroup;

  private fogDensity: number = 0.0;
  private scatteringCoeff: number = 1.0;
  private absorptionCoeff: number = 0.2; // Aumentado para god rays más definidos (antes 1.5)
  private multipleScatteringBoost: number = 1.3; // Energy compensation for multiple scattering (1.1-1.6)
  private anisotropy: number = 0.9; // Phase function g parameter (0.75-0.9 for god rays)
  private fogBaseHeight: number = 0.0; // Height fog base (world Y)
  private fogLayerHeight: number = 30.0; // Uniform fog layer thickness
  private fogFalloff: number = 0.08; // Exponential falloff above layer
  private ambientVolumetricIntensity: number = 0.0; // Ambient contribution to volumetric (keep low, 0.0-0.1)
  private nearPlane: number = 0.1;
  private farPlane: number = 50.0;
  private gLightFactor: number = 0.33;

  // Uniform buffers
  private volumetricUniformBuffer!: GPUBuffer;
  private froxelUniformBuffer!: GPUBuffer;
  private ambientUniformBuffer!: GPUBuffer;
  private volumetricUniformData: Float32Array;
  private froxelUniformData: Float32Array;

  private parametersBindGroup!: GPUBindGroup;
  private noiseTextureBindGroup!: GPUBindGroup;
  private rayMarchBindGroup!: GPUBindGroup;
  private ambientBindGroup!: GPUBindGroup;
  private directionalLightDataBindGroup!: GPUBindGroup;
  private selfOcclusionIOBindGroup!: GPUBindGroup;
  private selfOcclusionDirLightBindGroup!: GPUBindGroup;
  private lastCameraBuffer: GPUBuffer | null = null;
  private fogVolumeBuffer!: GPUBuffer;

  private static readonly MAX_FOG_VOLUMES = 16;
  /** Floats per FogVolume (64 bytes / 4 = 16 floats). Must match WGSL struct layout. */
  private static readonly FOG_VOLUME_FLOATS = 16;
  /** Bytes per FogVolume entry. */
  private static readonly FOG_VOLUME_STRIDE = 64;
  /**
   * Total fog volume buffer size:
   *   4 × u32 header (count + 3 padding = 16 bytes) +
   *   MAX_VOLUMES × FOG_VOLUME_STRIDE (1024 bytes) = 1040 bytes.
   */
  private static readonly FOG_VOLUME_BUFFER_SIZE =
    16 + FroxelVolumetricScattering.MAX_FOG_VOLUMES * FroxelVolumetricScattering.FOG_VOLUME_STRIDE;

  private pointLightTexturesBindGroups: Map<PointLightComponent, GPUBindGroup[]> = new Map();
  private pointLightDataBindGroups: Map<PointLightComponent, GPUBindGroup> = new Map();
  private spotLightTexturesBindGroups: Map<SpotLightComponent, GPUBindGroup[]> = new Map();
  private spotLightDataBindGroups: Map<SpotLightComponent, GPUBindGroup> = new Map();
  private integrationBindGroups: GPUBindGroup[] = [];
  private integrationDepthBindGroup!: GPUBindGroup;

  constructor() {
    this.device = GPUUtils.getDevice();
    this.volumetricUniformData = new Float32Array(16);
    this.froxelUniformData = new Float32Array(16);
    if (this.fogDensity <= 0.0) {
      this.isEnabled = false;
    }
  }

  public async load(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    this.noiseTexture = await Texture.getAsync('noiseRGBTileable.jpg');
    this.blueNoiseTexture = await Texture.getAsync('bluenoise64.png');
    await this.initializeComputeShaders();

    this.rayMarchTechnique = await Technique.getAsync('volumetric/froxel_raymarch.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.createUniformBuffers();

    this.create();
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

    const directionalLightInjectionCode = await ResourceManager.loadShader(
      'volumetric/froxel_light_injection_directional.compute.wgsl',
    );

    this.directionalLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Directional Light Injection Compute Shader',
      code: directionalLightInjectionCode,
    });

    const selfOcclusionCode = await ResourceManager.loadShader(
      'volumetric/froxel_self_occlusion.compute.wgsl',
    );

    this.selfOcclusionShader = this.device.createShaderModule({
      label: 'Froxel Self-Occlusion Compute Shader',
      code: selfOcclusionCode,
    });

    const pointLightInjectionCode = await ResourceManager.loadShader(
      'volumetric/froxel_light_injection_point.compute.wgsl',
    );

    this.pointLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Point Light Injection Compute Shader',
      code: pointLightInjectionCode,
    });

    const spotLightInjectionCode = await ResourceManager.loadShader(
      'volumetric/froxel_light_injection_spot.compute.wgsl',
    );

    this.spotLightInjectionShader = this.device.createShaderModule({
      label: 'Froxel Spot Light Injection Compute Shader',
      code: spotLightInjectionCode,
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
        BindGroupFactory.getDensityInputWithFogVolumeLayout(),
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
        BindGroupFactory.getIntegrationDepthLayout(),
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
        BindGroupFactory.getAmbientLightInjectionTexturesLayout(), // includes self-occlusion at binding 2
        BindGroupFactory.getDirectionalLightDataLayout(),
      ],
    );

    const directionalLightConfig: ComputePipelineConfig = {
      label: 'Froxel Directional Light Injection Compute Pipeline',
      layout: ambientLightInjectionPipelineLayout,
      compute: {
        module: this.directionalLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.directionalLightInjectionPipeline =
      PipelineFactory.createComputePipeline(directionalLightConfig);

    const selfOcclusionPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_self_occlusion_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelSelfOcclusionIOLayout(),
        BindGroupFactory.getFroxelLightParametersLayout(), // binding 3: dir light dir
      ],
    );

    const selfOcclusionConfig: ComputePipelineConfig = {
      label: 'Froxel Self-Occlusion Compute Pipeline',
      layout: selfOcclusionPipelineLayout,
      compute: {
        module: this.selfOcclusionShader,
        entryPoint: 'main',
      },
    };

    this.selfOcclusionPipeline = PipelineFactory.createComputePipeline(selfOcclusionConfig);

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

    const spotLightInjectionPipelineLayout = PipelineFactory.createPipelineLayout(
      'froxel_spot_light_injection_pipeline_layout',
      [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelPointTexturesLayout(),
        BindGroupFactory.getFroxelSpotLightDataLayout(),
      ],
    );

    const spotLightConfig: ComputePipelineConfig = {
      label: 'Froxel Spot Light Injection Compute Pipeline',
      layout: spotLightInjectionPipelineLayout,
      compute: {
        module: this.spotLightInjectionShader,
        entryPoint: 'main',
      },
    };

    this.spotLightInjectionPipeline = PipelineFactory.createComputePipeline(spotLightConfig);
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

    this.froxelDensityTextureView = this.froxelDensityTexture.createView();

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

    this.froxelIntegratedTextureView = this.froxelIntegratedTexture.createView();

    this.froxelLightTextureView = this.froxelLightTexture.createView();
    this.froxelLightTextureViewA = this.froxelLightTextureView;

    this.froxelLightTempTextureView = this.froxelLightTempTexture.createView();
    this.froxelLightTempTextureViewB = this.froxelLightTempTextureView;

    // Self-occlusion volume: one f32 transmittance value per froxel
    this.froxelSelfOcclusionTexture = this.device.createTexture({
      label: 'froxel_self_occlusion_3d',
      size: [x, y, z],
      dimension: '3d',
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.froxelSelfOcclusionTextureView = this.froxelSelfOcclusionTexture.createView();
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

    this.fogVolumeBuffer = GPUUtils.createBuffer(
      'froxel_fog_volume_data',
      FroxelVolumetricScattering.FOG_VOLUME_BUFFER_SIZE,
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
          resource: this.froxelDensityTextureView,
        },
      ],
    );

    this.integrationBindGroups = [
      BindGroupFactory.createBindGroup(
        'froxel_integration_bind_group_0',
        BindGroupFactory.getFroxelVolumetricIntegrationLayout(),
        [
          { binding: 0, resource: this.froxelDensityTextureView },
          { binding: 1, resource: this.froxelLightTextureViewA }, // lee de A
          { binding: 2, resource: this.froxelIntegratedTextureView },
          { binding: 3, resource: SamplerLibrary.nonFilteringSampler },
        ],
      ),
      BindGroupFactory.createBindGroup(
        'froxel_integration_bind_group_1',
        BindGroupFactory.getFroxelVolumetricIntegrationLayout(),
        [
          { binding: 0, resource: this.froxelDensityTextureView },
          { binding: 1, resource: this.froxelLightTempTextureViewB }, // lee de B
          { binding: 2, resource: this.froxelIntegratedTextureView },
          { binding: 3, resource: SamplerLibrary.nonFilteringSampler },
        ],
      ),
    ];
  }

  /**
   * Call when the screen is resized so stale screen-size-dependent bind groups are rebuilt.
   */
  public resize(): void {
    // Both bind groups hold references to the linearDepth RenderTarget view.
    // After a resize GBufferPass destroys that texture, so we must drop them
    // so they get recreated with the new view on the next updateFroxelData call.
    this.noiseTextureBindGroup = null as any;
    this.integrationDepthBindGroup = null as any;
  }

  public updateFroxelData(linearDepth: RenderTarget): void {
    if (!this.isEnabled || this.fogDensity === 0.0) {
      return;
    }

    // Resetear ping-pong al inicio de cada frame para estado consistente
    this.froxelLightTextureView = this.froxelLightTextureViewA;
    this.froxelLightTempTextureView = this.froxelLightTempTextureViewB;

    this.updateUniforms();

    // Use the MAIN encoder (same one used for shadow maps) so that:
    // shadow map render passes → froxel compute passes are ordered within
    // the same command buffer. Previously a separate encoder was submitted
    // immediately, reading shadow maps that were still pending in the main
    // encoder (previous frame's shadows) → flicker on camera rotation.
    const commandEncoder = Render.getInstance().getCommandEncoder();

    this.executeDensityPass(commandEncoder, linearDepth);

    this.executeSelfOcclusionPass(commandEncoder);

    this.executeDirectionalLightInjectionPass(commandEncoder);

    this.executePointLightInjectionPass(commandEncoder);

    this.executeSpotLightInjectionPass(commandEncoder);

    this.executeVolumetricIntegrationPass(commandEncoder, linearDepth);
    // No submit here — endFrame() submits everything together.
  }

  private executeDensityPass(commandEncoder: GPUCommandEncoder, linearDepth: RenderTarget): void {
    const densityTs = GPUProfiler.getInstance().getTimestampWrites('froxel_density_compute');
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_density_compute',
      ...(densityTs ? { timestampWrites: densityTs } : {}),
    });

    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const cameraBuffer = cameraComponent.getCamera().getUniformBuffer();

    if (!this.cameraBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;

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
        BindGroupFactory.getDensityInputWithFogVolumeLayout(),
        [
          {
            binding: 0,
            resource: this.noiseTexture.getTextureView()!,
          },
          {
            binding: 1,
            resource: SamplerLibrary.simpleSampler,
          },
          {
            binding: 2,
            resource: linearDepth.getRenderView(),
          },
          {
            binding: 3,
            resource: { buffer: this.fogVolumeBuffer },
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
  }

  private executeSelfOcclusionPass(commandEncoder: GPUCommandEncoder): void {
    const directionalLightComponent = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList()[0] as DirectionalLightComponent;

    if (!directionalLightComponent || !directionalLightComponent.getHasShadows()) {
      // No directional light — fill self-occlusion with 1.0 (no occlusion) so
      // the directional injection pass sees full transmittance.
      return;
    }

    const ts = GPUProfiler.getInstance().getTimestampWrites('froxel_self_occlusion_compute');
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_self_occlusion_compute',
      ...(ts ? { timestampWrites: ts } : {}),
    });

    if (!this.selfOcclusionIOBindGroup) {
      this.selfOcclusionIOBindGroup = BindGroupFactory.createBindGroup(
        'froxel_self_occlusion_io_bind_group',
        BindGroupFactory.getFroxelSelfOcclusionIOLayout(),
        [
          { binding: 0, resource: this.froxelDensityTextureView },
          { binding: 1, resource: this.froxelSelfOcclusionTextureView },
        ],
      );
    }

    if (!this.selfOcclusionDirLightBindGroup) {
      this.selfOcclusionDirLightBindGroup = BindGroupFactory.createBindGroup(
        'froxel_self_occlusion_dir_light_bind_group',
        BindGroupFactory.getFroxelLightParametersLayout(),
        [{ binding: 0, resource: { buffer: directionalLightComponent.getUniformBuffer() } }],
      );
    }

    computePass.setPipeline(this.selfOcclusionPipeline);
    computePass.setBindGroup(0, this.cameraBindGroup);
    computePass.setBindGroup(1, this.parametersBindGroup);
    computePass.setBindGroup(2, this.selfOcclusionIOBindGroup);
    computePass.setBindGroup(3, this.selfOcclusionDirLightBindGroup);

    const { x, y, z } = this.froxelDimensions;
    computePass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), Math.ceil(z / 4));
    computePass.end();
  }

  private executeVolumetricIntegrationPass(
    commandEncoder: GPUCommandEncoder,
    linearDepth: RenderTarget,
  ): void {
    const integrationTs = GPUProfiler.getInstance().getTimestampWrites(
      'froxel_volumetrict_integration_compute',
    );
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_volumetrict_integration_compute',
      ...(integrationTs ? { timestampWrites: integrationTs } : {}),
    });

    const pingPongIdx = this.froxelLightTextureView === this.froxelLightTextureViewA ? 0 : 1;

    if (!this.integrationDepthBindGroup) {
      this.integrationDepthBindGroup = BindGroupFactory.createBindGroup(
        'froxel_integration_depth_bind_group',
        BindGroupFactory.getIntegrationDepthLayout(),
        [{ binding: 0, resource: linearDepth.getView() }],
      );
    }

    computePass.setPipeline(this.volumetricIntegrationComputePipeline);
    computePass.setBindGroup(0, this.parametersBindGroup);
    computePass.setBindGroup(1, this.integrationBindGroups[pingPongIdx]);
    computePass.setBindGroup(2, this.integrationDepthBindGroup);

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8); // Workgroup size: 8x8x4
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(1);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();
  }

  private executeDirectionalLightInjectionPass(commandEncoder: GPUCommandEncoder): void {
    const directionalLightComponent = Engine.getEntities()
      .getObjectManagerByName('directional_light')
      ?.getList()[0] as DirectionalLightComponent;

    if (!directionalLightComponent || !directionalLightComponent.getHasShadows()) {
      return; // No directional light or no shadows
    }

    const dirLightTs = GPUProfiler.getInstance().getTimestampWrites(
      'froxel_directional_light_injection_compute',
    );
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_directional_light_injection_compute',
      ...(dirLightTs ? { timestampWrites: dirLightTs } : {}),
    });

    // Set compute pipeline
    computePass.setPipeline(this.directionalLightInjectionPipeline);

    // Create textures bind group (@group(1) in shader)
    if (!this.ambientBindGroup) {
      this.ambientBindGroup = BindGroupFactory.createBindGroup(
        'froxel_ambient_light_textures_bind_group',
        BindGroupFactory.getAmbientLightInjectionTexturesLayout(),
        [
          {
            binding: 0,
            resource: this.froxelLightTextureViewA,
          },
          {
            binding: 1,
            resource: {
              buffer: this.ambientUniformBuffer,
            },
          },
          {
            binding: 2,
            resource: this.froxelSelfOcclusionTextureView,
          },
        ],
      );
    }

    if (!this.directionalLightDataBindGroup) {
      this.directionalLightDataBindGroup = BindGroupFactory.createBindGroup(
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
            resource: directionalLightComponent.getShadowDepthView(1), // Shadow map (cascade 1)
          },
          {
            binding: 3,
            resource: directionalLightComponent.getShadowDepthView(2), // Shadow map (cascade 2)
          },
          {
            binding: 4,
            resource: directionalLightComponent.getShadowSampler(), // Comparison sampler
          },
        ],
      );
    }

    // Bind all resources
    computePass.setBindGroup(0, this.cameraBindGroup);
    computePass.setBindGroup(1, this.parametersBindGroup);
    computePass.setBindGroup(2, this.ambientBindGroup);
    computePass.setBindGroup(3, this.directionalLightDataBindGroup);

    // Dispatch compute workgroups
    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
    computePass.end();
  }

  private executePointLightInjectionPass(commandEncoder: GPUCommandEncoder): void {
    const pointLightManager = Engine.getEntities().getObjectManagerByName('point_light');
    if (!pointLightManager) return;
    const pointLights = pointLightManager.getList() as PointLightComponent[];

    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    let lightReadView = this.froxelLightTextureView;
    let lightWriteView = this.froxelLightTempTextureView;

    for (const pointLightComponent of pointLights) {
      if (!pointLightComponent.isVisible()) {
        continue;
      }
      const pointTs = GPUProfiler.getInstance().getTimestampWrites(
        'froxel_point_light_injection_compute',
      );
      const computePass = commandEncoder.beginComputePass({
        label: 'froxel_point_light_injection_compute',
        ...(pointTs ? { timestampWrites: pointTs } : {}),
      });

      computePass.setPipeline(this.pointLightInjectionPipeline);

      // Bind groups comunes
      computePass.setBindGroup(0, this.cameraBindGroup);
      computePass.setBindGroup(1, this.parametersBindGroup);

      // Cachear textures bind group por combinación [readView, writeView]
      // Como las views cambian con el swap, siempre hay exactamente 2 combinaciones posibles
      if (!this.pointLightTexturesBindGroups.has(pointLightComponent)) {
        this.pointLightTexturesBindGroups.set(pointLightComponent, [
          BindGroupFactory.createBindGroup(
            'froxel_point_light_textures_bind_group_0',
            BindGroupFactory.getFroxelPointTexturesLayout(),
            [
              { binding: 0, resource: this.froxelDensityTextureView },
              { binding: 1, resource: this.froxelLightTextureViewA },
              { binding: 2, resource: this.froxelLightTempTextureViewB },
            ],
          ),
          BindGroupFactory.createBindGroup(
            'froxel_point_light_textures_bind_group_1',
            BindGroupFactory.getFroxelPointTexturesLayout(),
            [
              { binding: 0, resource: this.froxelDensityTextureView },
              { binding: 1, resource: this.froxelLightTempTextureViewB },
              { binding: 2, resource: this.froxelLightTextureViewA },
            ],
          ),
        ]);
      }
      if (!this.pointLightDataBindGroups.has(pointLightComponent)) {
        this.pointLightDataBindGroups.set(
          pointLightComponent,
          BindGroupFactory.createBindGroup(
            'froxel_point_light_data_bind_group',
            BindGroupFactory.getFroxelLightParametersLayout(),
            [{ binding: 0, resource: { buffer: pointLightComponent.getUniformBuffer() } }],
          ),
        );
      }

      // Usar índice ping-pong para saber qué combinación usar
      const pingPongIdx = lightReadView === this.froxelLightTextureViewA ? 0 : 1;

      const texturesBindGroup =
        this.pointLightTexturesBindGroups.get(pointLightComponent)![pingPongIdx];
      const pointLightDataBindGroup = this.pointLightDataBindGroups.get(pointLightComponent)!;

      computePass.setBindGroup(2, texturesBindGroup);
      computePass.setBindGroup(3, pointLightDataBindGroup);

      computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
      computePass.end();

      const tmp = lightReadView;
      lightReadView = lightWriteView;
      lightWriteView = tmp;
    }

    this.froxelLightTextureView = lightReadView;
    this.froxelLightTempTextureView = lightWriteView;
  }

  private executeSpotLightInjectionPass(commandEncoder: GPUCommandEncoder): void {
    const spotLightManager = Engine.getEntities().getObjectManagerByName('spot_light');
    if (!spotLightManager) return;
    const spotLights = spotLightManager.getList() as SpotLightComponent[];

    const { x, y, z } = this.froxelDimensions;
    const dispatchX = Math.ceil(x / 8);
    const dispatchY = Math.ceil(y / 8);
    const dispatchZ = Math.ceil(z / 4);

    let lightReadView = this.froxelLightTextureView;
    let lightWriteView = this.froxelLightTempTextureView;

    for (const spotLightComponent of spotLights) {
      if (!spotLightComponent.isVisible()) {
        continue;
      }
      const spotTs = GPUProfiler.getInstance().getTimestampWrites(
        'froxel_spot_light_injection_compute',
      );
      const computePass = commandEncoder.beginComputePass({
        label: 'froxel_spot_light_injection_compute',
        ...(spotTs ? { timestampWrites: spotTs } : {}),
      });

      computePass.setPipeline(this.spotLightInjectionPipeline);

      // Bind groups comunes
      computePass.setBindGroup(0, this.cameraBindGroup);
      computePass.setBindGroup(1, this.parametersBindGroup);

      if (!this.spotLightTexturesBindGroups.has(spotLightComponent)) {
        this.spotLightTexturesBindGroups.set(spotLightComponent, [
          BindGroupFactory.createBindGroup(
            'froxel_spot_light_textures_bind_group_0',
            BindGroupFactory.getFroxelPointTexturesLayout(),
            [
              { binding: 0, resource: this.froxelDensityTextureView },
              { binding: 1, resource: this.froxelLightTextureViewA },
              { binding: 2, resource: this.froxelLightTempTextureViewB },
            ],
          ),
          BindGroupFactory.createBindGroup(
            'froxel_spot_light_textures_bind_group_1',
            BindGroupFactory.getFroxelPointTexturesLayout(),
            [
              { binding: 0, resource: this.froxelDensityTextureView },
              { binding: 1, resource: this.froxelLightTempTextureViewB },
              { binding: 2, resource: this.froxelLightTextureViewA },
            ],
          ),
        ]);
      }
      if (!this.spotLightDataBindGroups.has(spotLightComponent)) {
        this.spotLightDataBindGroups.set(
          spotLightComponent,
          BindGroupFactory.createBindGroup(
            'froxel_spot_light_data_bind_group',
            BindGroupFactory.getFroxelSpotLightDataLayout(),
            [
              { binding: 0, resource: { buffer: spotLightComponent.getUniformBuffer() } },
              { binding: 1, resource: spotLightComponent.getShadowDepthView() },
              { binding: 2, resource: spotLightComponent.getShadowSampler() },
              { binding: 3, resource: spotLightComponent.getProjectorTextureView() },
              { binding: 4, resource: SamplerLibrary.simpleSampler },
            ],
          ),
        );
      }

      const pingPongIdx = lightReadView === this.froxelLightTextureViewA ? 0 : 1;

      const texturesBindGroup =
        this.spotLightTexturesBindGroups.get(spotLightComponent)![pingPongIdx];
      const spotLightDataBindGroup = this.spotLightDataBindGroups.get(spotLightComponent)!;
      computePass.setBindGroup(2, texturesBindGroup);
      computePass.setBindGroup(3, spotLightDataBindGroup);
      computePass.dispatchWorkgroups(dispatchX, dispatchY, dispatchZ);
      computePass.end();

      const tmp = lightReadView;
      lightReadView = lightWriteView;
      lightWriteView = tmp;
    }

    this.froxelLightTextureView = lightReadView;
    this.froxelLightTempTextureView = lightWriteView;
  }

  public renderVolumetrics(sceneTarget: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const commandEncoder = render.getCommandEncoder();

    const froxelRenderTs = GPUProfiler.getInstance().getTimestampWrites(
      'froxel_volumetrics_render',
    );
    const renderPass = commandEncoder.beginRenderPass({
      label: 'froxel_volumetrics_render',
      ...(froxelRenderTs ? { timestampWrites: froxelRenderTs } : {}),
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

    if (!this.rayMarchBindGroup) {
      this.rayMarchBindGroup = BindGroupFactory.createBindGroup(
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
            resource: this.froxelIntegratedTextureView,
          },
          {
            binding: 3,
            resource: SamplerLibrary.simpleSampler,
          },
          {
            binding: 4,
            resource: this.blueNoiseTexture.getTextureView()!,
          },
          {
            binding: 5,
            resource: SamplerLibrary.froxelRaymarchSampler,
          },
        ],
      );
    }

    renderPass.setBindGroup(0, this.rayMarchBindGroup);
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
    this.volumetricUniformData[offset++] = this.gLightFactor;
    this.volumetricUniformData[offset++] = Render.width;
    this.volumetricUniformData[offset++] = Render.height;
    // Wind direction (world-space, pre-scaled). At default speed=0.08 matches original vec3(1,0,0.7) magnitude.
    const froxelWindScale = FroxelVolumetricScattering.FROXEL_WORLD_SPEED_SCALE * Wind.speed;
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cam = (mainCamera?.getComponent('camera') as CameraComponent | undefined)?.getCamera();
    const cameraFar = cam?.getFar() ?? 1000;
    const cameraTime = cam?.getTime() ?? 0;
    this.volumetricUniformData[offset++] = Wind.getDirX() * froxelWindScale; // windDir.x
    this.volumetricUniformData[offset++] = cameraFar; // windDir.y — actual cameraFar for raymarch depth
    this.volumetricUniformData[offset++] = Wind.getDirZ() * froxelWindScale; // windDir.z
    this.volumetricUniformData[offset++] = cameraTime; // windDir.w — temporal noise animation

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

    // Upload fog volume instances collected from ECS
    if (this.fogVolumeBuffer) {
      const fogVolumeList = Engine.getEntities().getObjectManagerByName('fog_volume')?.getList() as
        | FogVolumeComponent[]
        | undefined;
      const count = Math.min(
        fogVolumeList?.length ?? 0,
        FroxelVolumetricScattering.MAX_FOG_VOLUMES,
      );

      // Buffer: 16 bytes header (count u32 + 3 u32 padding) + MAX_VOLUMES * 64 bytes volumes
      const rawBuffer = new ArrayBuffer(FroxelVolumetricScattering.FOG_VOLUME_BUFFER_SIZE);
      const u32View = new Uint32Array(rawBuffer, 0, 4);
      const f32View = new Float32Array(rawBuffer, 16); // volumes start at byte 16
      u32View[0] = count;
      if (fogVolumeList) {
        for (let i = 0; i < count; i++) {
          const vol = fogVolumeList[i];
          if (vol) f32View.set(vol.getGPUData(), i * FroxelVolumetricScattering.FOG_VOLUME_FLOATS);
        }
      }
      this.device.queue.writeBuffer(this.fogVolumeBuffer, 0, rawBuffer);
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

  public renderInMenu(folder?: any): void {
    if (!this.isEnabled) {
      return;
    }
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Volumetric Scattering');
    this._editorFolder.close();

    this._editorFolder.add(this, 'fogDensity', 0.0, 0.03).name('Fog Density').listen();
    this._editorFolder.add(this, 'scatteringCoeff', 0.0, 2.0).name('Scattering Coeff').listen();
    this._editorFolder.add(this, 'absorptionCoeff', 0.0, 5.0).name('Absorption Coeff').listen();
    this._editorFolder.add(this, 'multipleScatteringBoost', 1.0, 2.0).name('MS Boost').listen();
    this._editorFolder.add(this, 'anisotropy', 0.0, 0.99).name('Anisotropy (g)').listen();
    this._editorFolder.add(this, 'fogBaseHeight', -10.0, 10.0).name('Fog Base Height').listen();
    this._editorFolder.add(this, 'fogLayerHeight', 1.0, 50.0).name('Fog Layer Height').listen();
    this._editorFolder.add(this, 'fogFalloff', 0.0, 1.0).name('Fog Falloff').listen();
    this._editorFolder
      .add(this, 'ambientVolumetricIntensity', 0.0, 0.2)
      .name('Ambient Volumetric')
      .listen();
    this._editorFolder.add(this, 'gLightFactor', 0.0, 1.0).name('G Light Factor').listen();
    this._editorFolder.add(this, 'nearPlane', 0.01, 1.0).name('Near Plane').listen();
    this._editorFolder.add(this, 'farPlane', 10.0, 200.0).name('Far Plane').listen();
  }

  public dispose(): void {
    this.volumetricUniformBuffer?.destroy();
    this.froxelUniformBuffer?.destroy();
    this.froxelDensityTexture?.destroy();
    this.froxelIntegratedTexture?.destroy();
    this.froxelLightTexture?.destroy();
    this.froxelLightTempTexture?.destroy();
    this.froxelSelfOcclusionTexture?.destroy();

    this.pointLightTexturesBindGroups.clear();
    this.pointLightDataBindGroups.clear();
    this.spotLightTexturesBindGroups.clear();
    this.spotLightDataBindGroups.clear();
  }

  public isVolumetricEnabled(): boolean {
    return this.isEnabled;
  }
}
