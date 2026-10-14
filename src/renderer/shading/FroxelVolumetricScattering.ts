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

  private temporalShader!: GPUShaderModule;
  private temporalPipeline!: GPUComputePipeline;

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

  // Temporal accumulation of the injected light (ping-pong history)
  private historyTextures: GPUTexture[] = [];
  private historyViews: GPUTextureView[] = [];
  private historyIndex = 0; // historyViews[historyIndex] = latest accumulated result
  private historyValid = false;
  private frameIndex = 0;
  private prevViewProj = new Float32Array(16);
  private temporalBindGroups: Map<string, GPUBindGroup> = new Map();

  // Raymarch: exact per-pixel sun term for the partially covered last slice
  private raymarchCSMBindGroup: GPUBindGroup | null = null;
  private raymarchCSMShadowView: GPUTextureView | null = null;
  private raymarchSliceBindGroups: GPUBindGroup[] = [];
  private dummyCSMBindGroup: GPUBindGroup | null = null;
  private dummyResources: (GPUTexture | GPUBuffer)[] = [];
  private directionalLightShadowView: GPUTextureView | null = null;
  private sunActive = false;

  private clearLightPipeline!: GPUComputePipeline;
  private clearLightBindGroup!: GPUBindGroup;

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
  private farPlane: number = 50.0;
  // Slice distribution: depth(s) = (2^(s/S) - 1) / B. S = slices/2 gives slices
  // ~0.35 m thick next to the camera and ~1.4 m at 50 m (64 slices).
  private depthDistScale: number = 32.0;
  // Weight of the reprojected history in the light volume (0 = no temporal filter).
  private temporalBlend: number = 0.9;
  private gLightFactor: number = 0.33;
  private debugView: boolean = false;
  private loaded = false;
  private resourcesCreated = false;

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

  constructor() {
    this.device = GPUUtils.getDevice();
    this.volumetricUniformData = new Float32Array(16);
    // dimensions(4) + near/far/S/B(4) + jitter(4) + prevViewProj(16)
    this.froxelUniformData = new Float32Array(28);
  }

  /**
   * Shaders and pipelines are always loaded (cheap) so fog can be switched on at
   * runtime; the 3D textures are only allocated the first frame that actually
   * has participating media (global fog or a FogVolume).
   */
  public async load(): Promise<void> {
    this.noiseTexture = await Texture.getAsync('noiseRGBTileable.jpg');
    this.blueNoiseTexture = await Texture.getAsync('bluenoise64.png');
    await this.initializeComputeShaders();

    this.rayMarchTechnique = await Technique.getAsync('volumetric/froxel_raymarch.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    this.createUniformBuffers();
    this.loaded = true;
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

    const temporalCode = await ResourceManager.loadShader('volumetric/froxel_temporal.compute.wgsl');

    this.temporalShader = this.device.createShaderModule({
      label: 'Froxel Temporal Reprojection Compute Shader',
      code: temporalCode,
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
        BindGroupFactory.getCameraComputeLayout(),
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
        BindGroupFactory.getFroxelPointLightDataLayout(),
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

    // Zero-fills the first light texture when there is no shadowed sun to write it
    // (point / spot passes accumulate on top of it).
    this.clearLightPipeline = PipelineFactory.createComputePipeline({
      label: 'Froxel Clear Light Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('froxel_clear_light_pipeline_layout', [
        BindGroupFactory.getFroxelRGBA16StorageLayout(),
      ]),
      compute: {
        module: this.device.createShaderModule({
          label: 'Froxel Clear Light Compute Shader',
          code: `
@group(0) @binding(0) var lightTex: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= textureDimensions(lightTex))) { return; }
  textureStore(lightTex, gid, vec4<f32>(0.0));
}`,
        }),
        entryPoint: 'main',
      },
    });

    this.temporalPipeline = PipelineFactory.createComputePipeline({
      label: 'Froxel Temporal Reprojection Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout('froxel_temporal_pipeline_layout', [
        BindGroupFactory.getCameraComputeLayout(),
        BindGroupFactory.getFroxelParametersLayout(),
        BindGroupFactory.getFroxelTemporalLayout(),
      ]),
      compute: {
        module: this.temporalShader,
        entryPoint: 'main',
      },
    });
  }

  public create(): void {
    this.createFroxelTextures();
    this.createBindGroups();
    this.resourcesCreated = true;
    this.historyValid = false;
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

    this.historyTextures = [0, 1].map((i) =>
      this.device.createTexture({
        label: `froxel_light_history_${i}`,
        size: [x, y, z],
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.historyViews = this.historyTextures.map((t) => t.createView());
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

    this.clearLightBindGroup = BindGroupFactory.createBindGroup(
      'froxel_clear_light_bind_group',
      BindGroupFactory.getFroxelRGBA16StorageLayout(),
      [{ binding: 0, resource: this.froxelLightTextureViewA }],
    );

    // Integration reads the temporally filtered light (historyViews[i] = this frame's output).
    this.integrationBindGroups = this.historyViews.map((historyView, i) =>
      BindGroupFactory.createBindGroup(
        `froxel_integration_bind_group_${i}`,
        BindGroupFactory.getFroxelVolumetricIntegrationLayout(),
        [
          { binding: 0, resource: this.froxelDensityTextureView },
          { binding: 1, resource: historyView },
          { binding: 2, resource: this.froxelIntegratedTextureView },
          { binding: 3, resource: SamplerLibrary.nonFilteringSampler },
        ],
      ),
    );
  }

  /**
   * Call when the screen is resized so stale screen-size-dependent bind groups are rebuilt.
   */
  public resize(): void {
    // Both bind groups hold references to the linearDepth RenderTarget view.
    // After a resize GBufferPass destroys that texture, so we must drop them
    // so they get recreated with the new view on the next updateFroxelData call.
    this.noiseTextureBindGroup = null as any;
    this.ambientBindGroup = null as any;
  }

  private getFogVolumeCount(): number {
    const list = Engine.getEntities().getObjectManagerByName('fog_volume')?.getList();
    return list ? list.length : 0;
  }

  public updateFroxelData(linearDepth: RenderTarget): void {
    if (!this.isVolumetricEnabled()) {
      this.historyValid = false;
      return;
    }
    if (!this.resourcesCreated) {
      this.create();
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

    if (!this.executeDirectionalLightInjectionPass(commandEncoder, linearDepth)) {
      this.executeClearLightPass(commandEncoder);
    }

    this.executePointLightInjectionPass(commandEncoder);

    this.executeSpotLightInjectionPass(commandEncoder);

    this.executeTemporalPass(commandEncoder);

    this.executeVolumetricIntegrationPass(commandEncoder);
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
      this.raymarchSliceBindGroups = [];

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

  private executeTemporalPass(commandEncoder: GPUCommandEncoder): void {
    const readHistory = this.historyIndex;
    const writeHistory = 1 - this.historyIndex;
    const currentIsA = this.froxelLightTextureView === this.froxelLightTextureViewA;
    const key = `${currentIsA ? 'A' : 'B'}${writeHistory}`;

    let bindGroup = this.temporalBindGroups.get(key);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        `froxel_temporal_bind_group_${key}`,
        BindGroupFactory.getFroxelTemporalLayout(),
        [
          { binding: 0, resource: this.froxelLightTextureView },
          { binding: 1, resource: this.historyViews[readHistory]! },
          { binding: 2, resource: SamplerLibrary.froxelRaymarchSampler },
          { binding: 3, resource: this.historyViews[writeHistory]! },
        ],
      );
      this.temporalBindGroups.set(key, bindGroup);
    }

    const ts = GPUProfiler.getInstance().getTimestampWrites('froxel_temporal_compute');
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_temporal_compute',
      ...(ts ? { timestampWrites: ts } : {}),
    });
    computePass.setPipeline(this.temporalPipeline);
    computePass.setBindGroup(0, this.cameraBindGroup);
    computePass.setBindGroup(1, this.parametersBindGroup);
    computePass.setBindGroup(2, bindGroup);
    const { x, y, z } = this.froxelDimensions;
    computePass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), Math.ceil(z / 4));
    computePass.end();

    this.historyIndex = writeHistory;
    this.historyValid = true;
  }

  private executeVolumetricIntegrationPass(commandEncoder: GPUCommandEncoder): void {
    const integrationTs = GPUProfiler.getInstance().getTimestampWrites(
      'froxel_volumetrict_integration_compute',
    );
    const computePass = commandEncoder.beginComputePass({
      label: 'froxel_volumetrict_integration_compute',
      ...(integrationTs ? { timestampWrites: integrationTs } : {}),
    });

    computePass.setPipeline(this.volumetricIntegrationComputePipeline);
    computePass.setBindGroup(0, this.parametersBindGroup);
    computePass.setBindGroup(1, this.integrationBindGroups[this.historyIndex]!);
    computePass.setBindGroup(2, this.cameraBindGroup);

    // One thread per froxel column
    const { x, y } = this.froxelDimensions;
    computePass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), 1);
    computePass.end();
  }

  private executeClearLightPass(commandEncoder: GPUCommandEncoder): void {
    const computePass = commandEncoder.beginComputePass({ label: 'froxel_clear_light_compute' });
    computePass.setPipeline(this.clearLightPipeline);
    computePass.setBindGroup(0, this.clearLightBindGroup);
    const { x, y, z } = this.froxelDimensions;
    computePass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), Math.ceil(z / 4));
    computePass.end();
  }

  private getShadowedSun(): DirectionalLightComponent | null {
    const sun = Engine.getEntities().getObjectManagerByName('directional_light')?.getList()[0] as
      | DirectionalLightComponent
      | undefined;
    return sun && sun.getHasShadows() ? sun : null;
  }

  /** Returns false when there is no shadowed directional light (nothing written). */
  private executeDirectionalLightInjectionPass(
    commandEncoder: GPUCommandEncoder,
    linearDepth: RenderTarget,
  ): boolean {
    const directionalLightComponent = this.getShadowedSun();
    if (!directionalLightComponent) {
      return false;
    }

    // Shadow maps can be recreated (resolution / cascade changes) — rebuild on change.
    const shadowView0 = directionalLightComponent.getShadowDepthView(0);
    if (shadowView0 !== this.directionalLightShadowView) {
      this.directionalLightShadowView = shadowView0;
      this.directionalLightDataBindGroup = null as any;
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
          {
            binding: 3,
            resource: linearDepth.getRenderView(), // depth-aware sample rejection
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
    return true;
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
            BindGroupFactory.getFroxelPointLightDataLayout(),
            [
              { binding: 0, resource: { buffer: pointLightComponent.getUniformBuffer() } },
              { binding: 1, resource: pointLightComponent.getShadowDepthView() },
              { binding: 2, resource: pointLightComponent.getShadowSampler() },
            ],
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
    if (!this.resourcesCreated || !this.isVolumetricEnabled()) return;
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
    renderPass.setBindGroup(2, this.getRaymarchCSMBindGroup());
    renderPass.setBindGroup(3, this.getRaymarchSliceBindGroup());

    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }

  private getRaymarchCSMBindGroup(): GPUBindGroup {
    const sun = this.getShadowedSun();
    if (!sun) {
      return this.getDummyCSMBindGroup();
    }
    const view0 = sun.getShadowDepthView(0);
    if (!this.raymarchCSMBindGroup || view0 !== this.raymarchCSMShadowView) {
      this.raymarchCSMShadowView = view0;
      this.raymarchCSMBindGroup = BindGroupFactory.createBindGroup(
        'froxel_raymarch_csm_bind_group',
        BindGroupFactory.getGodRaysVolumetricCSMLayout(),
        [
          { binding: 0, resource: { buffer: sun.getUniformBuffer() } },
          { binding: 1, resource: view0 },
          { binding: 2, resource: sun.getShadowDepthView(1) },
          { binding: 3, resource: sun.getShadowDepthView(2) },
          { binding: 4, resource: sun.getShadowSampler() },
        ],
      );
    }
    return this.raymarchCSMBindGroup;
  }

  /** Placeholder CSM bindings for scenes without a shadowed sun (sunPartial = 0, never sampled). */
  private getDummyCSMBindGroup(): GPUBindGroup {
    if (!this.dummyCSMBindGroup) {
      const depth = this.device.createTexture({
        label: 'froxel_dummy_shadow_depth',
        size: [1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      const buffer = GPUUtils.createBuffer(
        'froxel_dummy_csm_uniforms',
        256,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      this.dummyResources.push(depth, buffer);
      const view = depth.createView();
      this.dummyCSMBindGroup = BindGroupFactory.createBindGroup(
        'froxel_raymarch_dummy_csm_bind_group',
        BindGroupFactory.getGodRaysVolumetricCSMLayout(),
        [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: view },
          { binding: 2, resource: view },
          { binding: 3, resource: view },
          { binding: 4, resource: SamplerLibrary.shadows },
        ],
      );
    }
    return this.dummyCSMBindGroup;
  }

  private getRaymarchSliceBindGroup(): GPUBindGroup {
    if (this.raymarchSliceBindGroups.length === 0) {
      this.raymarchSliceBindGroups = this.historyViews.map((historyView, i) =>
        BindGroupFactory.createBindGroup(
          `froxel_raymarch_slice_bind_group_${i}`,
          BindGroupFactory.getFroxelRaymarchSliceLayout(),
          [
            { binding: 0, resource: { buffer: this.lastCameraBuffer! } },
            { binding: 1, resource: this.froxelDensityTextureView },
            { binding: 2, resource: historyView },
            { binding: 3, resource: this.froxelSelfOcclusionTextureView },
          ],
        ),
      );
    }
    return this.raymarchSliceBindGroups[this.historyIndex]!;
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
    const slices = this.froxelDimensions.z;
    const depthDistScale = Math.max(this.depthDistScale, 1.0);
    offset = 0;
    this.froxelUniformData[offset++] = this.froxelDimensions.x;
    this.froxelUniformData[offset++] = this.froxelDimensions.y;
    this.froxelUniformData[offset++] = slices;
    this.froxelUniformData[offset++] = this.debugView ? 1.0 : 0.0; // w: debug view (fog only)
    this.sunActive = this.getShadowedSun() !== null;
    this.froxelUniformData[offset++] = this.sunActive ? 1.0 : 0.0; // sunPartial
    this.froxelUniformData[offset++] = this.farPlane;
    this.froxelUniformData[offset++] = depthDistScale;
    this.froxelUniformData[offset++] = (Math.pow(2, slices / depthDistScale) - 1) / this.farPlane;
    // Per-frame sample offset inside each froxel (Halton 2,3,5 — 16-frame cycle)
    const jitterIndex = (this.frameIndex++ % 16) + 1;
    this.froxelUniformData[offset++] = FroxelVolumetricScattering.halton(jitterIndex, 2);
    this.froxelUniformData[offset++] = FroxelVolumetricScattering.halton(jitterIndex, 3);
    this.froxelUniformData[offset++] = FroxelVolumetricScattering.halton(jitterIndex, 5);
    this.froxelUniformData[offset++] = this.historyValid ? this.temporalBlend : 0.0;
    // Previous frame view-projection for temporal reprojection, then remember this one.
    this.froxelUniformData.set(this.prevViewProj, offset);
    if (cam) this.prevViewProj.set(cam.getViewProjection());

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
    this._editorFolder.add(this, 'farPlane', 10.0, 200.0).name('Far Plane').listen();
    this._editorFolder
      .add(this, 'depthDistScale', 4.0, 128.0)
      .name('Depth Distribution')
      .listen();
    this._editorFolder.add(this, 'temporalBlend', 0.0, 0.98).name('Temporal Blend').listen();
    this._editorFolder.add(this, 'debugView').name('Debug: Fog Only').listen();
  }

  public dispose(): void {
    this.volumetricUniformBuffer?.destroy();
    this.froxelUniformBuffer?.destroy();
    this.froxelDensityTexture?.destroy();
    this.froxelIntegratedTexture?.destroy();
    this.froxelLightTexture?.destroy();
    this.froxelLightTempTexture?.destroy();
    this.froxelSelfOcclusionTexture?.destroy();
    for (const t of this.historyTextures) t.destroy();
    this.historyTextures = [];
    this.historyViews = [];
    this.temporalBindGroups.clear();
    this.raymarchSliceBindGroups = [];
    for (const r of this.dummyResources) r.destroy();
    this.dummyResources = [];
    this.dummyCSMBindGroup = null;
    this.resourcesCreated = false;

    this.pointLightTexturesBindGroups.clear();
    this.pointLightDataBindGroups.clear();
    this.spotLightTexturesBindGroups.clear();
    this.spotLightDataBindGroups.clear();
  }

  public isVolumetricEnabled(): boolean {
    return (
      this.isEnabled && this.loaded && (this.fogDensity > 0.0 || this.getFogVolumeCount() > 0)
    );
  }

  private static halton(index: number, base: number): number {
    let result = 0;
    let f = 1 / base;
    let i = index;
    while (i > 0) {
      result += f * (i % base);
      i = Math.floor(i / base);
      f /= base;
    }
    return result;
  }
}
