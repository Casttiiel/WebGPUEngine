import { GPUUtils } from '../utils/GPUUtils';
import { PipelineBindGroupLayouts } from '../../../types/PipelineBindGroupLayouts.enum';

export interface BindGroupEntry {
  binding: number;
  resource: GPUBindingResource;
}

export interface BindGroupLayoutEntry {
  binding: number;
  visibility: GPUShaderStageFlags;
  buffer?: GPUBufferBindingLayout;
  texture?: GPUTextureBindingLayout;
  sampler?: GPUSamplerBindingLayout;
  storageTexture?: GPUStorageTextureBindingLayout;
}

/**
 * Factory for creating bind groups and layouts with common patterns
 */
export class BindGroupFactory {
  private static layouts: Map<string, GPUBindGroupLayout> = new Map();

  /**
   * Creates or retrieves a cached bind group layout
   */
  public static getLayout(key: string, entries: BindGroupLayoutEntry[]): GPUBindGroupLayout {
    if (!this.layouts.has(key)) {
      const layout = GPUUtils.getDevice().createBindGroupLayout({
        label: key,
        entries,
      });
      this.layouts.set(key, layout);
    }
    return this.layouts.get(key)!;
  }

  /**
   * Creates a bind group with the specified layout and entries
   */
  public static createBindGroup(
    label: string,
    layout: GPUBindGroupLayout,
    entries: BindGroupEntry[],
  ): GPUBindGroup {
    return GPUUtils.getDevice().createBindGroup({
      label,
      layout,
      entries,
    });
  }

  /**
   * Creates a standard camera uniforms bind group layout
   */
  public static getCameraUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('camera_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a standard object uniforms bind group layout
   */
  public static getObjectUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('object_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a standard material textures bind group layout
   */
  public static getMaterialTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('material_textures', [
      // Albedo texture
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Normal texture
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Metallic texture
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Roughness texture
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Emissive texture
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Shared sampler
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a G-Buffer bind group layout
   */
  public static getGBufferLayout(): GPUBindGroupLayout {
    return this.getLayout('gbuffer', [
      // Albedo texture
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Normal texture
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Linear depth texture
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Shared sampler
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getSingleTextureLayout(): GPUBindGroupLayout {
    return this.getLayout('single_texture', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getSSRUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getSSRComposeUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_compose_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          viewDimension: 'cube',
          sampleType: 'float',
          multisampled: false,
        },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getSkyboxUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('skybox uniforms layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  /**
   * Creates a cubemap texture bind group layout
   */
  public static getCubemapTextureLayout(): GPUBindGroupLayout {
    return this.getLayout('cubemap_texture', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          viewDimension: 'cube',
          sampleType: 'float',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getAmbientUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('ambient uniforms layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          viewDimension: 'cube',
          sampleType: 'float',
          multisampled: false,
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  /**
   * Creates a buffer uniform bind group layout
   */
  public static getBufferUniformLayout(): GPUBindGroupLayout {
    return this.getLayout('buffer_uniform', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a depth texture bind group layout
   */
  public static getDepthTextureLayout(): GPUBindGroupLayout {
    return this.getLayout('depth_texture', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: true,
        },
      },
    ]);
  }

  public static getFourTextureLayout(): GPUBindGroupLayout {
    return this.getLayout('four_texture', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
    ]);
  }

  public static getFroxelUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_uniforms_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' }, // Camera uniforms
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' }, // Froxel uniforms
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' }, // Volumetric uniforms
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
        }, // Froxel density texture (3D)
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'float',
          viewDimension: '3d',
        }, // Froxel scattering texture (3D)
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'non-filtering' }, // Non-filtering sampler for unfilterable textures
      },
    ]);
  }

  /**
   * Create bind group layout for froxel density uniforms (group 0)
   */
  public static getFroxelDensityUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_density_uniforms_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Camera uniforms
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Froxel uniforms
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Volumetric uniforms
      },
    ]);
  }

  /**
   * Create bind group layout for camera uniforms (compute version)
   */
  public static getCameraComputeLayout(): GPUBindGroupLayout {
    return this.getLayout('camera_compute_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Camera uniforms
      },
    ]);
  }

  /**
   * Create bind group layout for froxel parameters only (no camera)
   */
  public static getFroxelParametersLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_parameters_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Froxel uniforms
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // Volumetric uniforms
      },
    ]);
  }

  /**
   * Create bind group layout for froxel textures (compute version)
   */
  public static getFroxelTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'r32float', // Match actual density texture format
          viewDimension: '3d',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'float',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'non-filtering' },
      },
    ]);
  }

  /**
   * Create bind group layout for froxel scattering textures (compute version)
   */
  public static getFroxelScatteringTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_scattering_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float', // froxelDensityTexture is r32float (unfilterable)
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float', // This matches the rgba16float format used in shader and texture creation
          viewDimension: '3d',
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'non-filtering' },
      },
    ]);
  }

  /**
   * Create bind group layout for froxel density textures (group 1)
   */
  public static getFroxelDensityTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_density_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'r32float',
          viewDimension: '3d',
        }, // Output density texture
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'float',
          viewDimension: '2d',
        }, // Noise texture (2D)
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' }, // Noise sampler
      },
    ]);
  }

  /**
   * Create bind group layout for froxel scattering computation
   */
  public static getFroxelScatteringLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_scattering_layout', [
      // Camera uniforms (binding 0)
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      // Froxel uniforms (binding 1)
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      // Volumetric uniforms (binding 2)
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      // Froxel light texture - input (binding 3)
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'float',
          viewDimension: '3d',
        },
      },
      // Froxel density texture - input (binding 4)
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
        },
      },
      // Froxel scattering texture - output (binding 5)
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
          viewDimension: '3d',
        },
      },
      // Non-filtering sampler (binding 6) - required for unfilterable textures
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'non-filtering' },
      },
    ]);
  }

  public static getAOUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('AO uniforms layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
    ]);
  }

  /**
   * Creates a bloom parameters bind group layout
   */
  public static getBloomParamsLayout(): GPUBindGroupLayout {
    return this.getLayout('bloom_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a Gaussian blur uniforms bind group layout
   */
  public static getGaussianBlurUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('gaussian_blur_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates a directional light uniforms bind group layout
   * Includes uniform buffer, depth texture and comparison sampler for shadows
   */
  public static getDirectionalLightUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('directional_light_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      },
    ]);
  }

  public static getTemporalAccumulationUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('temporal accumulation uniforms layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getParticleUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('particle_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {
          type: 'read-only-storage',
          hasDynamicOffset: false,
        },
      },
    ]);
  }

  /**
   * Creates a storage buffer layout for instancing
   */
  public static getInstanceStorageLayout(): GPUBindGroupLayout {
    return this.getLayout('instance_storage', [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
    ]);
  }

  /**
   * DOF parameters (focus_distance, aperture, focal_length, sensor_height)
   */
  public static getDOFParamsLayout(): GPUBindGroupLayout {
    return this.getLayout('dof_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * DOF blur textures (inputTexture, cocTexture, sampler)
   */
  public static getDOFBlurTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('dof_blur_textures', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  /**
   * DOF composite textures (originalTexture, nearBlurTexture, farBlurTexture, cocTexture)
   */
  public static getDOFCompositeTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('dof_composite_textures', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getMotionBlurParamsLayout(): GPUBindGroupLayout {
    return this.getLayout('motion_blur_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getSMAAParamsLayout(): GPUBindGroupLayout {
    return this.getLayout('smaa_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getSMAABlendTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('smaa_blend_textures', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getSMAABlendParamsLayout(): GPUBindGroupLayout {
    return this.getLayout('smaa_blend_params', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates velocity buffer uniforms bind group layout
   * @group(1) @binding(0) var<uniform> previousViewProjection: mat4x4<f32>;
   */
  public static getVelocityBufferUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('velocity_buffer_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Creates bind group layout from enum
   */ public static getLayoutFromEnum(layout: PipelineBindGroupLayouts): GPUBindGroupLayout {
    switch (layout) {
      case PipelineBindGroupLayouts.CAMERA_UNIFORMS:
        return this.getCameraUniformsLayout();
      case PipelineBindGroupLayouts.OBJECT_UNIFORMS:
        return this.getObjectUniformsLayout();
      case PipelineBindGroupLayouts.MATERIAL_TEXTURES:
        return this.getMaterialTexturesLayout();
      case PipelineBindGroupLayouts.SINGLE_TEXTURE:
        return this.getSingleTextureLayout();
      case PipelineBindGroupLayouts.SSR_UNIFORMS:
        return this.getSSRUniformsLayout();
      case PipelineBindGroupLayouts.SSR_COMPOSE_UNIFORMS:
        return this.getSSRComposeUniformsLayout();
      case PipelineBindGroupLayouts.SKYBOX_UNIFORMS:
        return this.getSkyboxUniformsLayout();
      case PipelineBindGroupLayouts.CUBEMAP_TEXTURE:
        return this.getCubemapTextureLayout();
      case PipelineBindGroupLayouts.AMBIENT_UNIFORMS:
        return this.getAmbientUniformsLayout();
      case PipelineBindGroupLayouts.GBUFFER_UNIFORMS:
        return this.getGBufferLayout();
      case PipelineBindGroupLayouts.BUFFER_UNIFORM:
        return this.getBufferUniformLayout();
      case PipelineBindGroupLayouts.DEPTH_TEXTURE:
        return this.getDepthTextureLayout();
      case PipelineBindGroupLayouts.FOUR_TEXTURE:
        return this.getFourTextureLayout();
      case PipelineBindGroupLayouts.FROXEL_UNIFORMS:
        return this.getFroxelUniformsLayout();
      case PipelineBindGroupLayouts.AO_UNIFORMS:
        return this.getAOUniformsLayout();
      case PipelineBindGroupLayouts.DIRECTIONAL_LIGHT_UNIFORMS:
        return this.getDirectionalLightUniformsLayout();
      case PipelineBindGroupLayouts.TEMPORAL_ACCUMULATION_UNIFORMS:
        return this.getTemporalAccumulationUniformsLayout();
      case PipelineBindGroupLayouts.PARTICLE_UNIFORMS:
        return this.getParticleUniformsLayout();
      case PipelineBindGroupLayouts.INSTANCE_STORAGE:
        return this.getInstanceStorageLayout();
      case PipelineBindGroupLayouts.DOF_PARAMS:
        return this.getDOFParamsLayout();
      case PipelineBindGroupLayouts.DOF_BLUR_TEXTURES:
        return this.getDOFBlurTexturesLayout();
      case PipelineBindGroupLayouts.DOF_COMPOSITE_TEXTURES:
        return this.getDOFCompositeTexturesLayout();
      case PipelineBindGroupLayouts.MOTION_BLUR_PARAMS:
        return this.getMotionBlurParamsLayout();
      case PipelineBindGroupLayouts.SMAA_PARAMS:
        return this.getSMAAParamsLayout();
      case PipelineBindGroupLayouts.SMAA_BLEND_TEXTURES:
        return this.getSMAABlendTexturesLayout();
      case PipelineBindGroupLayouts.SMAA_BLEND_PARAMS:
        return this.getSMAABlendParamsLayout();
      case PipelineBindGroupLayouts.VELOCITY_BUFFER_UNIFORMS:
        return this.getVelocityBufferUniformsLayout();
      default:
        throw new Error(`Unknown bind group layout: ${layout}`);
    }
  }

  /**
   * Clears all cached layouts
   */
  public static clearCache(): void {
    this.layouts.clear();
  }
}
