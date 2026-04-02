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
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Normal texture
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Metallic texture
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Roughness texture
      {
        binding: 3,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Emissive texture
      {
        binding: 4,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // Shared sampler
      {
        binding: 5,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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

  /**
   * G-Buffer layout extended with AO texture + sampler (bindings 4 and 5).
   * Used by all lighting shaders so they can read the AO micro-shadow term
   * without needing an extra bind group slot.
   */
  public static getGBufferWithAOLayout(): GPUBindGroupLayout {
    return this.getLayout('gbuffer_with_ao', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // AO micro-shadow
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }, // AO sampler
    ]);
  }

  /** Same structure as getGBufferLayout() but with COMPUTE visibility — for AO/SSGI compute passes. */
  public static getGBufferComputeLayout(): GPUBindGroupLayout {
    return this.getLayout('gbuffer_compute', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
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

  public static getSingleTextureComputeLayout(): GPUBindGroupLayout {
    return this.getLayout('single_texture_compute', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  public static getDensityInputTextureLayout(): GPUBindGroupLayout {
    return this.getLayout('density_input_texture_compute', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
    ]);
  }

  /**
   * Extended density input layout adding binding(3) for the fog volume uniform buffer.
   * Used exclusively by the density pipeline so other pipelines are unaffected.
   */
  public static getDensityInputWithFogVolumeLayout(): GPUBindGroupLayout {
    return this.getLayout('density_input_with_fog_volume', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
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

  /** Same as getSSRUniformsLayout() but with COMPUTE visibility — used by ssr.cs. */
  public static getSSRUniformsComputeLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_uniforms_compute', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]);
  }

  /** Write-only rgba16float storage texture output for the SSR compute pass (group 3). */
  public static getSSROutputLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_output_storage', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
    ]);
  }

  /**
   * Group 0 for ssr_blur.cs: raw SSR texture (read) + linear sampler.
   * group(0) @binding(0) = ssrRaw (texture_2d<f32>)
   * group(0) @binding(1) = samplerLinear
   */
  public static getSSRBlurInputLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_blur_input', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ]);
  }

  /**
   * Group 1 for ssr_blur.cs: GBuffer normals + linear depth for bilateral weights.
   * group(1) @binding(0) = gNormals      (texture_2d<f32>)
   * group(1) @binding(1) = gLinearDepth  (texture_2d<f32>)
   * group(1) @binding(2) = samplerPoint
   */
  public static getSSRBlurGBufferLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_blur_gbuffer', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ]);
  }

  /**
   * Group 2 for ssr_blur.cs: blurred SSR storage output.
   * group(2) @binding(0) = outputBlurred (texture_storage_2d<rgba16float, write>)
   */
  public static getSSRBlurOutputLayout(): GPUBindGroupLayout {
    return this.getLayout('ssr_blur_output', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
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

  /**
   * OIT glass env bind group layout — extends cubemap with a 2D BRDF split-sum LUT.
   * group(3) in oit_gather.fs:
   *   binding 0 — prefiltered env cubemap
   *   binding 1 — env sampler
   *   binding 2 — BRDF LUT (split-sum, U=NdotV V=roughness)
   *   binding 3 — accLight snapshot before glass pass (screen-space refraction)
   */
  public static getOITGlassEnvLayout(): GPUBindGroupLayout {
    return this.getLayout('oit_glass_env', [
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
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' }, // screen-space refraction snapshot
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
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          viewDimension: 'cube',
          sampleType: 'float',
          multisampled: false,
        },
      },
    ]);
  }
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
        texture: {
          sampleType: 'float',
          viewDimension: '3d',
        },
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

  public static getFroxelLightParametersLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_light_parameters_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
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

  public static getFroxelVolumetricIntegrationLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_volumetric_integration_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
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
   * Create bind group layout for ambient light injection textures
   */
  public static getAmbientLightInjectionTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('ambient_light_injection_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float', // froxelScatteringTexture output
          viewDimension: '3d',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'uniform',
        },
      },
      {
        // Self-occlusion transmittance texture (read-only, r32float)
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
    ]);
  }

  public static getFroxelPointTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_point_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float',
          viewDimension: '3d',
        },
      },
    ]);
  }

  /**
   * Create bind group layout for directional light injection textures (@group(2))
   * Binding 0: density (input, unfilterable)
   * Binding 1: light (input, filterable for reading existing light)
   * Binding 2: light (output, storage for writing accumulated light)
   */
  public static getDirectionalLightInjectionTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('directional_light_injection_textures_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float', // froxelDensityTexture is r32float (unfilterable)
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'float', // froxelLightTexture is rgba16float (filterable)
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'rgba16float', // froxelLightTexture output
          viewDimension: '3d',
        },
      },
    ]);
  }

  /**
   * Create bind group layout for directional light data (@group(3))
   * Binding 0: DirectionalLightUniforms buffer
   * Binding 1: Shadow map depth texture
   * Binding 2: Shadow sampler (comparison sampler)
   */
  public static getDirectionalLightDataLayout(): GPUBindGroupLayout {
    return this.getLayout('directional_light_data_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'uniform',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        sampler: {
          type: 'comparison',
        },
      },
    ]);
  }

  public static getFroxelSpotLightDataLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_spot_light_data_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'uniform',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: {
          type: 'comparison',
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'float' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: 'filtering' },
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
          format: 'rg32float',
          viewDimension: '3d',
        }, // Output density texture
      },
    ]);
  }

  /**
   * Layout for the self-occlusion compute pass (@group(2)):
   *   binding 0 — density texture (read, unfilterable-float 3D)
   *   binding 1 — self-occlusion texture (write, r32float storage 3D)
   */
  public static getFroxelSelfOcclusionIOLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_self_occlusion_io_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: 'write-only',
          format: 'r32float',
          viewDimension: '3d',
        },
      },
    ]);
  }

  /**
   * Layout for reading the self-occlusion texture in the directional injection
   * pass (@group(4)):
   *   binding 0 — self-occlusion texture (read, unfilterable-float 3D)
   */
  public static getFroxelSelfOcclusionReadLayout(): GPUBindGroupLayout {
    return this.getLayout('froxel_self_occlusion_read_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: 'unfilterable-float',
          viewDimension: '3d',
          multisampled: false,
        },
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
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
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
   * Creates a bind group layout for point lights with cubemap shadow support.
   * Binding 1 is texture_depth_cube instead of texture_depth_2d.
   */
  public static getPointLightShadowUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('point_light_shadow_uniforms', [
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
          viewDimension: 'cube',
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
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

  /**
   * Bind group layout for spot light data (@group(3))
   * binding 0: uniform buffer (LightUniforms)
   * binding 1: depth 2D texture (shadow map)
   * binding 2: comparison sampler
   * binding 3: 2D float texture (projector)
   * binding 4: filtering sampler
   */
  public static getSpotLightUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('spot_light_uniforms', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
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

  /**
   * Bind group layout for Cascaded Shadow Mapping (CSM) directional light.
   * Includes uniform buffer + 3 shadow maps + comparison sampler.
   */
  public static getDirectionalLightCSMUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('directional_light_csm_uniforms', [
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
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d',
          multisampled: false,
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      },
      // Contact shadow factor map: [0,1] scalar produced by ContactShadowsComponent
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
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
      {
        // ParticleRenderParams: startSize, endSize, startColor, endColor
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
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
   * @group(2) @binding(0) var<uniform> previousUnjitteredVP:    mat4x4<f32>;
   * @group(2) @binding(1) var<uniform> currentUnjitteredInvVP:  mat4x4<f32>;
   */
  public static getVelocityBufferUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('velocity_buffer_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * God rays params bind group layout (group 2).
   * binding 0: GodRaysParams uniform (32 bytes)
   */
  public static getGodRaysUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('god_rays_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Kawase blur step params layout (group 2).
   * binding 0: KawaseParams uniform (16 bytes — offset f32 + 3× padding)
   */
  public static getKawaseUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('kawase_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  /**
   * Contact shadows bind group layout (group 2).
   * Now outputs a shadow-factor map — only needs the params uniform buffer.
   * binding 0: ContactShadowParams uniform
   */
  public static getContactShadowsUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('contact_shadows_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ]);
  }

  public static getFogUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('fog_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
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
   * Auto Exposure read layout (group 1) used by tone_mapping.fs.
   * binding 0: storage buffer (read-only) — contains current adapted exposure f32
   */
  public static getAutoExposureReadLayout(): GPUBindGroupLayout {
    return this.getLayout('auto_exposure_read', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
    ]);
  }

  /**
   * OIT compose bind group layout (group 0).
   * binding 0: accumulation texture (RGBA16F)
   * binding 1: revealage texture (RGBA8)
   * binding 2: sampler
   */
  /** group(1) for palette_quantize.fs: input texture + sampler + params uniform buffer. */
  public static getPaletteQuantizeLayout(): GPUBindGroupLayout {
    return this.getLayout('palette_quantize', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ]);
  }

  public static getOITComposeTexturesLayout(): GPUBindGroupLayout {
    return this.getLayout('oit_compose_textures', [
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

  public static getAtmosphericFogUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('atmospheric_fog_uniforms', [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
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
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ]);
  }

  /** Compute bind group layout for the tile-culling pass (group 1). */
  public static getTiledLightComputeCullingLayout(): GPUBindGroupLayout {
    return this.getLayout('tiled_light_compute_culling', [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ]);
  }

  /** Fragment bind group layout for the tiled lighting pass (group 2). */
  public static getTiledLightRenderLayout(): GPUBindGroupLayout {
    return this.getLayout('tiled_light_render', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ]);
  }

  /** Fragment bind group layout for a single area light uniform buffer (group 2). */
  public static getAreaLightUniformsLayout(): GPUBindGroupLayout {
    return this.getLayout('area_light_uniforms', [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
      case PipelineBindGroupLayouts.OIT_GLASS_ENV:
        return this.getOITGlassEnvLayout();
      case PipelineBindGroupLayouts.AMBIENT_UNIFORMS:
        return this.getAmbientUniformsLayout();
      case PipelineBindGroupLayouts.GBUFFER_UNIFORMS:
        return this.getGBufferLayout();
      case PipelineBindGroupLayouts.GBUFFER_WITH_AO_UNIFORMS:
        return this.getGBufferWithAOLayout();
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
      case PipelineBindGroupLayouts.DIRECTIONAL_LIGHT_CSM_UNIFORMS:
        return this.getDirectionalLightCSMUniformsLayout();
      case PipelineBindGroupLayouts.TEMPORAL_ACCUMULATION_UNIFORMS:
        return this.getTemporalAccumulationUniformsLayout();
      case PipelineBindGroupLayouts.PARTICLE_UNIFORMS:
        return this.getParticleUniformsLayout();
      case PipelineBindGroupLayouts.PARTICLE_WORLDSPACE_UNIFORMS:
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
      case PipelineBindGroupLayouts.POINT_LIGHT_SHADOW_UNIFORMS:
        return this.getPointLightShadowUniformsLayout();
      case PipelineBindGroupLayouts.SPOT_LIGHT_UNIFORMS:
        return this.getSpotLightUniformsLayout();
      case PipelineBindGroupLayouts.SPOT_LIGHT_UNIFORMS:
        return this.getSpotLightUniformsLayout();
      case PipelineBindGroupLayouts.VELOCITY_BUFFER_UNIFORMS:
        return this.getVelocityBufferUniformsLayout();
      case PipelineBindGroupLayouts.FOG_UNIFORMS:
        return this.getFogUniformsLayout();
      case PipelineBindGroupLayouts.CONTACT_SHADOWS_UNIFORMS:
        return this.getContactShadowsUniformsLayout();
      case PipelineBindGroupLayouts.AUTO_EXPOSURE_READ:
        return this.getAutoExposureReadLayout();
      case PipelineBindGroupLayouts.OIT_COMPOSE_TEXTURES:
        return this.getOITComposeTexturesLayout();
      case PipelineBindGroupLayouts.PALETTE_QUANTIZE:
        return this.getPaletteQuantizeLayout();
      case PipelineBindGroupLayouts.ATMOSPHERIC_FOG_UNIFORMS:
        return this.getAtmosphericFogUniformsLayout();
      case PipelineBindGroupLayouts.TILED_LIGHT_COMPUTE_CULLING:
        return this.getTiledLightComputeCullingLayout();
      case PipelineBindGroupLayouts.TILED_LIGHT_RENDER:
        return this.getTiledLightRenderLayout();
      case PipelineBindGroupLayouts.AREA_LIGHT_UNIFORMS:
        return this.getAreaLightUniformsLayout();
      case PipelineBindGroupLayouts.GOD_RAYS_UNIFORMS:
        return this.getGodRaysUniformsLayout();
      case PipelineBindGroupLayouts.KAWASE_UNIFORMS:
        return this.getKawaseUniformsLayout();
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
