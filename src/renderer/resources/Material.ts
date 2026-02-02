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
import { GPUUtils } from '../core/utils/GPUUtils';

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
  baseColorFactor?: number[];
  roughnessFactor?: number;
  metallicFactor?: number;
  emissiveFactor?: number;
  uvXScale?: number;
  uvYScale?: number;
}

export type MaterialCreateOptions = MaterialBaseOptions & Omit<IGPUResourceOptions, 'type'>;
export type MaterialOptions = Required<Pick<MaterialBaseOptions, 'textures' | 'technique'>> &
  Omit<MaterialCreateOptions, 'textures' | 'technique'> &
  IGPUResourceOptions;

export class Material extends GPUResource {
  private technique?: Technique;
  private textures: Map<string, Texture> = new Map();
  private baseColorFactor!: number[];
  private roughnessFactor!: number;
  private metallicFactor!: number;
  private emissiveFactor!: number;
  private uvXScale!: number;
  private uvYScale!: number;
  private category: RenderCategory;
  private castsShadows: boolean;
  private shadows: boolean;
  private textureBindGroup?: GPUBindGroup;
  private textureFiles: MaterialTexturesOptions;
  private shadowsMaterial?: Material;

  constructor(options: MaterialOptions) {
    super({
      ...options,
      type: ResourceType.MATERIAL,
    });

    this.category = options.category || RenderCategory.SOLIDS;
    this.castsShadows = options.castsShadows ?? true;
    this.shadows = options.shadows ?? false;
    this.technique = options.technique;
    this.textureFiles = options.textures;
    this.baseColorFactor = options.baseColorFactor ?? [1, 1, 1, 1];
    this.roughnessFactor = options.roughnessFactor ?? 1;
    this.metallicFactor = options.metallicFactor ?? 1;
    this.emissiveFactor = options.emissiveFactor ?? 1;
    this.uvXScale = options.uvXScale ?? 1;
    this.uvYScale = options.uvYScale ?? 1;
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

    const techniqueToUse = await Technique.getAsync(techniqueSource);
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
      baseColorFactor: materialData?.baseColorFactor || [1.0, 1.0, 1.0, 1.0],
      roughnessFactor:
        materialData?.roughnessFactor !== undefined ? materialData.roughnessFactor : 1.0,
      metallicFactor:
        materialData?.metallicFactor !== undefined ? materialData.metallicFactor : 1.0,
      emissiveFactor:
        materialData?.emissiveFactor !== undefined ? materialData.emissiveFactor : 1.0,
      uvXScale: materialData?.uvXScale !== undefined ? materialData.uvXScale : 1.0,
      uvYScale: materialData?.uvYScale !== undefined ? materialData.uvYScale : 1.0,
      castsShadows: materialData?.casts_shadows !== undefined ? materialData.casts_shadows : true,
      shadows: materialData?.shadows !== undefined ? materialData.shadows : false,
    });

    await material.load();
    ResourceManager.registerResource(material);
    return material;
  }

  public override async load(): Promise<void> {
    try {
      if (this.castsShadows) {
        // Si este material usa una técnica instanciada, el shadowsMaterial también debe usarla
        const isInstancedTechnique = this.technique?.path.includes('_instanced.tech');

        if (isInstancedTechnique) {
          // Crear material de sombras con técnica instanciada
          const shadowsMaterialData = {
            technique: 'shadows/shadows_instanced.tech',
            textures: {},
            category: 'shadows' as any,
            casts_shadows: false,
          };
          this.shadowsMaterial = await Material.get(shadowsMaterialData);
        } else {
          this.shadowsMaterial = await Material.get('shadows.mat');
        }
      }

      // Cargar todas las texturas en paralelo usando Promise.all
      await Promise.all([
        this.loadTexture('albedo', this.textureFiles.albedo),
        this.loadTexture('normal', this.textureFiles.normal),
        this.loadTexture('metallic', this.textureFiles.metallic),
        this.loadTexture('roughness', this.textureFiles.roughness),
        this.loadTexture('emissive', this.textureFiles.emissive),
      ]);
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

    bindingIndex++;

    const uniformBuffer = GPUUtils.createBuffer(
      'material uniform buffer',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    GPUUtils.writeBuffer(uniformBuffer, 0, new Float32Array(this.baseColorFactor));
    GPUUtils.writeBuffer(
      uniformBuffer,
      16,
      new Float32Array([this.roughnessFactor, this.metallicFactor, this.emissiveFactor, 0]),
    );
    GPUUtils.writeBuffer(uniformBuffer, 32, new Float32Array([this.uvXScale, this.uvYScale, 0, 0]));

    entries.push({
      binding: 6,
      resource: { buffer: uniformBuffer },
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

  private loadTexture(type: string, path: string): Promise<void> {
    return Texture.getAsync(path).then((texture) => {
      this.textures.set(type, texture);
    });
  }

  public getCategory(): RenderCategory {
    return this.category;
  }

  public getCastsShadows(): boolean {
    return this.castsShadows;
  }

  public getShadowsMaterial(): Material {
    return this.shadowsMaterial!;
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

  public getTextureFiles(): MaterialTexturesOptions {
    return this.textureFiles;
  }

  public getName(): string {
    return this.path;
  }

  public getBaseColorFactor(): number[] {
    return this.baseColorFactor;
  }

  public getRoughnessFactor(): number {
    return this.roughnessFactor;
  }

  public getMetallicFactor(): number {
    return this.metallicFactor;
  }

  public getEmissiveFactor(): number {
    return this.emissiveFactor;
  }

  public getUvXScale(): number {
    return this.uvXScale;
  }

  public getUvYScale(): number {
    return this.uvYScale;
  }

  public override release(): void {}
}
