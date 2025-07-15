import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { MaterialDataType } from '../../types/MaterialData.type';
import { Technique } from './Technique';
import { Texture } from './Texture';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';

export interface MaterialTexturesOptions {
  albedo: string;
  normal: string;
  metallic: string;
  roughness: string;
  emissive: string;
}

export interface MaterialBaseOptions {
  category?: RenderCategory;
  castsShadows?: boolean;
  shadows?: boolean;
  textures?: MaterialTexturesOptions;
  technique?: Technique;
}

export type MaterialCreateOptions = MaterialBaseOptions & Omit<IGPUResourceOptions, 'type'>;
export type MaterialOptions = Required<Pick<MaterialBaseOptions, 'textures' | 'technique'>> &
  Omit<MaterialCreateOptions, 'textures' | 'technique'> &
  IGPUResourceOptions;

export class Material extends GPUResource {
  private technique?: Technique;
  private textures: Map<string, Texture> = new Map();
  private category: RenderCategory;
  private castsShadows: boolean;
  private shadows: boolean;
  private textureBindGroup?: GPUBindGroup;
  private textureFiles: MaterialTexturesOptions;

  constructor(options: MaterialOptions) {
    super({
      ...options,
      type: ResourceType.MATERIAL,
    });

    this.category = options.category || RenderCategory.SOLIDS;
    this.castsShadows = options.castsShadows ?? false;
    this.shadows = options.shadows ?? false;
    this.technique = options.technique;
    this.textureFiles = options.textures;
  }

  public static async get(pathOrData: string | MaterialDataType): Promise<Material> {
    let materialData = null;
    if (typeof pathOrData === 'string') {
      try {
        return ResourceManager.getResource<Material>(pathOrData);
      } catch {
        // Load material data from file if needed
        materialData = await ResourceManager.loadMaterialData(pathOrData);
      }
    } else {
      materialData = pathOrData;
    }

    const techniqueSource =
      materialData.technique !== undefined
        ? materialData.technique
        : materialData.techniqueData !== undefined
          ? materialData.techniqueData
          : undefined;

    if (techniqueSource === undefined) {
      throw new Error(`Missing technique for material: ${pathOrData}`);
    }

    const techniqueToUse = await Technique.get(techniqueSource);
    if (!techniqueToUse) {
      throw new Error(`Missing technique for material: ${pathOrData}`);
    }

    const textures: MaterialTexturesOptions = {
      albedo: materialData?.textures.txAlbedo || 'white.png',
      normal: materialData?.textures.txNormal || 'no-normal.jpg',
      metallic: materialData?.textures.txMetallic || 'black.png',
      roughness: materialData?.textures.txRoughness || 'black.png',
      emissive: materialData?.textures.txEmissive || 'black.png',
    };

    const material = new Material({
      path:
        typeof pathOrData === 'string'
          ? pathOrData
          : `dynamic_material_${Engine.generateDynamicId()}`,
      type: ResourceType.MATERIAL,
      technique: techniqueToUse,
      textures,
      category: materialData?.category,
      castsShadows: materialData?.casts_shadows,
      shadows: materialData?.shadows,
    });

    await material.load();
    ResourceManager.registerResource(material);
    return material;
  }

  public override async load(): Promise<void> {
    try {
      // Load textures secuencialmente para evitar race conditions
      await this.loadTexture('albedo', this.textureFiles.albedo);
      await this.loadTexture('normal', this.textureFiles.normal);
      await this.loadTexture('metallic', this.textureFiles.metallic);
      await this.loadTexture('roughness', this.textureFiles.roughness);
      await this.loadTexture('emissive', this.textureFiles.emissive);

      // Note: Bind group will be created later when we have the pipeline
      this.createBindGroup();
    } catch (error) {
      throw new Error(`Failed to create GPU resources for material ${this.path}: ${error}`);
    }
  }

  private async createBindGroup(): Promise<void> {
    if (!this.technique) {
      throw new Error('Technique not loaded');
    }
    const entries: GPUBindGroupEntry[] = [];
    let bindingIndex = 0;

    const textureTypes = ['albedo', 'normal', 'metallic', 'roughness', 'emissive'];
    for (const type of textureTypes) {
      const texture = this.textures.get(type);
      if (!texture) {
        throw new Error(`Missing texture: ${type}`);
      }

      const view = texture.getTextureView();
      const sampler = texture.getSampler();

      if (!view || !sampler) {
        throw new Error(`Texture ${type} view or sampler not available`);
      }

      entries.push({
        binding: bindingIndex,
        resource: view,
      });
      bindingIndex++;
    }

    const texture = this.textures.get('albedo');
    if (!texture) {
      throw new Error(`Required albedo texture not found for material ${this.label}`);
    }
    const sampler = texture.getSampler();
    if (!sampler) {
      throw new Error(`Sampler not available for albedo texture in material ${this.label}`);
    }
    entries.push({
      binding: bindingIndex,
      resource: sampler,
    });

    const textureBingGroupLayout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.MATERIAL_TEXTURES,
    );

    // Create bind group
    this.textureBindGroup = BindGroupFactory.createBindGroup(
      `${this.label}_texture_bindgroup`,
      textureBingGroupLayout,
      entries,
    );
  }

  private async loadTexture(type: string, path: string): Promise<void> {
    const texture = await Texture.get(path);
    this.textures.set(type, texture);
  }

  public getCategory(): RenderCategory {
    return this.category;
  }

  public getCastsShadows(): boolean {
    return this.castsShadows;
  }

  public getShadows(): boolean {
    return this.shadows;
  }

  public getTechnique(): Technique | undefined {
    return this.technique;
  }

  public getTextureBindGroup(): GPUBindGroup | undefined {
    return this.textureBindGroup;
  }

  public getName(): string {
    return this.path;
  }

  public override release(): void {}
}
