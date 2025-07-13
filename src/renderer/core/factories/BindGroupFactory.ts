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
      // Self illumination texture
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      // AO texture
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
    ]);
  } 
  
  /**
   * Creates a single texture bind group layout
   */
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
   * Creates a cubemap with BRDF LUT bind group layout
   */
  public static getCubemapWithBRDFLayout(): GPUBindGroupLayout {
    return this.getLayout('cubemap_with_brdf', [
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
        texture: {
          viewDimension: '2d',
          sampleType: 'float',
          multisampled: false,
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
        texture: {
          viewDimension: 'cube',
          sampleType: 'float',
          multisampled: false,
        },
      },
      {
        binding: 5,
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
      case PipelineBindGroupLayouts.CUBEMAP_TEXTURE:
        return this.getCubemapTextureLayout();
      case PipelineBindGroupLayouts.CUBEMAP_WITH_BRDF:
        return this.getCubemapWithBRDFLayout();
      case PipelineBindGroupLayouts.GBUFFER_UNIFORMS:
        return this.getGBufferLayout();
      case PipelineBindGroupLayouts.BUFFER_UNIFORM:
        return this.getBufferUniformLayout();
      case PipelineBindGroupLayouts.DEPTH_TEXTURE:
        return this.getDepthTextureLayout();
      case PipelineBindGroupLayouts.FOUR_TEXTURE:
        return this.getFourTextureLayout();
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
