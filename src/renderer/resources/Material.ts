import { GPUResource, IGPUResourceOptions } from '../../core/resources/GPUResource';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { MaterialDataType } from '../../types/MaterialData.type';
import { TechniqueMaterialSlot } from '../../types/TechniqueData.type';
import { Technique } from './Technique';
import { Texture } from './Texture';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { GPUUtils } from '../core/utils/GPUUtils';
import { EngineTextureRegistry } from '../core/utils/EngineTextureRegistry';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';

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
  /** Decal blend weight for albedo + normal channels. 1 = full blend, 0 = no change. Default 1. */
  appearanceBlend?: number;
  /** Decal blend weight for roughness + metallic channels. 1 = full blend, 0 = no change. Default 1. */
  surfaceBlend?: number;
  /** Parallax Occlusion Mapping height scale. 0 = disabled (default). Typical range 0.01–0.1. */
  pomScale?: number;
  /** Raw texture map forwarded from .mat file, used by the custom-slot path. */
  rawTextures?: Record<string, string>;
}

export type MaterialCreateOptions = MaterialBaseOptions & Omit<IGPUResourceOptions, 'type'>;
export type MaterialOptions = Required<Pick<MaterialBaseOptions, 'technique'>> &
  Omit<MaterialCreateOptions, 'technique'> &
  IGPUResourceOptions;

export class Material extends GPUResource {
  // Prevents duplicate registration for string-path materials under parallel load.
  private static readonly inflight = new Map<string, Promise<Material>>();

  private technique?: Technique;
  private textures: Map<string, Texture> = new Map();
  private baseColorFactor!: number[];
  private roughnessFactor!: number;
  private metallicFactor!: number;
  private emissiveFactor!: number;
  private uvXScale!: number;
  private uvYScale!: number;
  private appearanceBlend!: number;
  private surfaceBlend!: number;
  private pomScale!: number;
  private category: RenderCategory;
  private castsShadows: boolean;
  private shadows: boolean;
  private textureBindGroup?: GPUBindGroup;
  private textureFiles: MaterialTexturesOptions | undefined;
  private shadowsMaterial?: Material;

  // --- Custom material slot state ---
  /** Raw texture map from the .mat file, used by the custom-slot path. */
  private rawTextures: Record<string, string> = {};
  /** Pre-loaded file-based textures for custom slots (async-loaded at Material.load() time). */
  private customSlotTextures: Map<string, Texture> = new Map();
  /** GPUBuffer for the material-factors uniform in custom-slot materials. */
  private customUniformBuffer: GPUBuffer | undefined;
  /** GPUBuffer for the material-factors uniform in the standard PBR path. */
  private uniformBuffer: GPUBuffer | undefined;
  /** Unsubscribe functions from EngineTextureRegistry — called in release(). */
  private customUnsubscribes: Array<() => void> = [];

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
    this.rawTextures = options.rawTextures ?? {};
    this.baseColorFactor = options.baseColorFactor ?? [1, 1, 1, 1];
    this.roughnessFactor = options.roughnessFactor ?? 1;
    this.metallicFactor = options.metallicFactor ?? 1;
    this.emissiveFactor = options.emissiveFactor ?? 1;
    this.uvXScale = options.uvXScale ?? 1;
    this.uvYScale = options.uvYScale ?? 1;
    this.appearanceBlend = options.appearanceBlend ?? 1;
    this.surfaceBlend = options.surfaceBlend ?? 1;
    this.pomScale = (options as any).pomScale ?? 0;
  }

  public static async get(pathOrData: string | MaterialDataType): Promise<Material> {
    let materialData = null;
    if (typeof pathOrData === 'string') {
      // 1. Already registered.
      try {
        return ResourceManager.getResource<Material>(pathOrData);
      } catch {
        // not registered yet
      }

      // 2. Another concurrent call is already loading this path.
      const existing = this.inflight.get(pathOrData);
      if (existing) return existing;

      // 3. First caller: wrap the work in a stored promise before any await.
      const path = pathOrData;
      const promise = (async () => {
        const data = await ResourceManager.loadMaterialData(path);
        const mat = await this.buildMaterial(path, data);
        this.inflight.delete(path);
        return mat;
      })();
      this.inflight.set(path, promise);
      return promise;
    } else {
      materialData = pathOrData;
    }

    // Inline MaterialDataType — always a unique dynamic material, no dedup needed.
    return this.buildMaterial(`dynamic_material_${Engine.generateDynamicId()}`, materialData!);
  }

  private static async buildMaterial(
    path: string,
    materialData: MaterialDataType,
  ): Promise<Material> {
    const techniqueSource =
      materialData.technique !== undefined
        ? materialData.technique
        : materialData.techniqueData !== undefined
          ? materialData.techniqueData
          : undefined;

    if (techniqueSource === undefined) {
      throw new Error(`Missing technique for material: ${path}`);
    }

    const techniqueToUse = await Technique.getAsync(techniqueSource);
    if (!techniqueToUse) {
      throw new Error(`Missing technique for material: ${path}`);
    }

    const textures: MaterialTexturesOptions = {
      albedo: materialData?.textures?.txAlbedo || 'white.png',
      normal: materialData?.textures?.txNormal || 'no-normal.jpg',
      metallic: materialData?.textures?.txMetallic || 'black.png',
      roughness: materialData?.textures?.txRoughness || 'black.png',
      emissive: materialData?.textures?.txEmissive || 'black.png',
    };

    const material = new Material({
      path,
      type: ResourceType.MATERIAL,
      technique: techniqueToUse,
      textures,
      rawTextures: (materialData?.textures as Record<string, string>) ?? {},
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
      appearanceBlend:
        materialData?.appearanceBlend !== undefined ? materialData.appearanceBlend : 1.0,
      surfaceBlend: materialData?.surfaceBlend !== undefined ? materialData.surfaceBlend : 1.0,
      pomScale: materialData?.pomScale !== undefined ? materialData.pomScale : 0.0,
      castsShadows: materialData?.casts_shadows !== undefined ? materialData.casts_shadows : true,
      shadows: materialData?.shadows !== undefined ? materialData.shadows : false,
    });

    await material.load();
    ResourceManager.registerResource(material);
    return material;
  }

  public override async load(): Promise<void> {
    try {
      const slots = this.technique?.getMaterialSlots();
      if (slots) {
        // ── Custom-slot path ─────────────────────────────────────────────────
        await this.createCustomBindGroup(slots);
      } else {
        // ── PBR path (unchanged) ──────────────────────────────────────────────
        // Build the shadow material promise (if needed) and the 5 texture promises,
        // then await all of them in parallel — shadow fetch no longer blocks textures.
        const shadowPromise = this.castsShadows
          ? (() => {
              const isInstancedTechnique = this.technique?.path.includes('_instanced.tech');
              if (isInstancedTechnique) {
                return Material.get({
                  technique: 'shadows/shadows_instanced.tech',
                  textures: {},
                  category: 'shadows' as any,
                  casts_shadows: false,
                }).then((m) => {
                  this.shadowsMaterial = m;
                });
              } else {
                return Material.get('shadows.mat').then((m) => {
                  this.shadowsMaterial = m;
                });
              }
            })()
          : Promise.resolve();

        await Promise.all([
          shadowPromise,
          this.loadTexture('albedo', this.textureFiles?.albedo ?? 'white.png'),
          this.loadTexture('normal', this.textureFiles?.normal ?? 'no-normal.jpg'),
          this.loadTexture('metallic', this.textureFiles?.metallic ?? 'black.png'),
          this.loadTexture('roughness', this.textureFiles?.roughness ?? 'black.png'),
          this.loadTexture('emissive', this.textureFiles?.emissive ?? 'black.png'),
        ]);
        this.createBindGroup();
      }
    } catch (error) {
      throw new Error(`Failed to create GPU resources for material ${this.path}: ${error}`);
    }
  }

  /**
   * Custom-slot path: loads all file-based textures, subscribes to engine textures,
   * and builds the bind group once all resources are available.
   */
  private async createCustomBindGroup(slots: ReadonlyArray<TechniqueMaterialSlot>): Promise<void> {
    // 1. Collect all file-based texture paths and load them in parallel.
    const fileLoadPromises: Promise<void>[] = [];
    for (const slot of slots) {
      if (slot.type === 'sampler' || slot.type === 'uniform') continue;
      const matValue = this.rawTextures[slot.name];
      const value = matValue ?? slot.defaultValue;
      if (!value) continue;
      if (!value.startsWith('@engine:') && !value.startsWith('@sampler:')) {
        fileLoadPromises.push(
          Texture.getAsync(value, false).then((tex) => {
            this.customSlotTextures.set(slot.name, tex);
          }),
        );
      }
    }
    await Promise.all(fileLoadPromises);

    // 2. Create the material-factors uniform buffer (used by 'uniform' slots).
    this.customUniformBuffer = GPUUtils.createBuffer(
      `${this.label}_custom_uniform`,
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.writeFactorsToGPU();

    // 3. Subscribe to all engine textures used by this material.
    //    When views change (e.g. after resize), rebuild the bind group synchronously.
    const rebuild = () => this.tryBuildCustomBindGroup(slots);
    for (const slot of slots) {
      if (slot.type === 'sampler' || slot.type === 'uniform') continue;
      const matValue = this.rawTextures[slot.name];
      const value = matValue ?? slot.defaultValue ?? '';
      if (value.startsWith('@engine:')) {
        const engineName = value.slice(1); // strip leading '@' → 'engine:linear_depth'
        this.customUnsubscribes.push(EngineTextureRegistry.subscribe(engineName, rebuild));
      }
    }

    // 4. Attempt an initial build (may be a no-op if engine textures aren't registered yet).
    this.tryBuildCustomBindGroup(slots);
  }

  /**
   * Synchronously builds the custom bind group from already-loaded resources.
   * Silently returns if any engine texture is not yet available — it will be
   * called again when that texture gets registered.
   */
  private tryBuildCustomBindGroup(slots: ReadonlyArray<TechniqueMaterialSlot>): void {
    const layout = this.technique?.getCustomMaterialLayout();
    if (!layout) return;

    const entries: GPUBindGroupEntry[] = [];

    for (const slot of slots) {
      const matValue = this.rawTextures[slot.name];
      const value = matValue ?? slot.defaultValue ?? '';

      if (slot.type === 'uniform') {
        if (!this.customUniformBuffer) return;
        entries.push({ binding: slot.binding, resource: { buffer: this.customUniformBuffer } });
        continue;
      }

      if (slot.type === 'sampler') {
        const sampler = this.resolveSampler(value);
        if (!sampler) return;
        entries.push({ binding: slot.binding, resource: sampler });
        continue;
      }

      // Texture slot
      if (value.startsWith('@engine:')) {
        const engineName = value.slice(1); // 'engine:linear_depth'
        const view = EngineTextureRegistry.get(engineName);
        if (!view) return; // Not ready yet — will rebuild when registered
        entries.push({ binding: slot.binding, resource: view });
      } else if (value.startsWith('@sampler:')) {
        // @sampler: prefix in a texture slot shouldn't happen, but guard anyway
        return;
      } else {
        const tex = this.customSlotTextures.get(slot.name);
        if (!tex) return;
        const view = tex.getTextureView();
        if (!view) return;
        entries.push({ binding: slot.binding, resource: view });
      }
    }

    this.textureBindGroup = BindGroupFactory.createBindGroup(
      `${this.label}_custom_bindgroup`,
      layout,
      entries,
    );
  }

  /** Resolves a sampler from a "@sampler:<key>" reference or returns null. */
  private resolveSampler(value: string): GPUSampler | null {
    if (!value.startsWith('@sampler:')) return null;
    const key = value.slice('@sampler:'.length) as keyof typeof SamplerLibrary;
    const sampler = (SamplerLibrary as any)[key] as GPUSampler | undefined;
    return sampler ?? null;
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

    this.uniformBuffer = GPUUtils.createBuffer(
      'material uniform buffer',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.writeFactorsToGPU();

    entries.push({
      binding: 6,
      resource: { buffer: this.uniformBuffer },
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
    // Normal maps must use the normalise-after-average mipmap generator to avoid
    // shimmering at distance caused by box-filtering encoded normal vectors.
    return Texture.getAsync(path, type === 'normal').then((texture) => {
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

  public getTextureFiles(): MaterialTexturesOptions | undefined {
    return this.textureFiles;
  }

  public override getName(): string {
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

  public getAppearanceBlend(): number {
    return this.appearanceBlend;
  }

  public getSurfaceBlend(): number {
    return this.surfaceBlend;
  }

  public getPomScale(): number {
    return this.pomScale;
  }

  /**
   * Update one or more material factors and immediately write them to the GPU uniform buffer.
   * Works for both the standard PBR path and the custom-slot path.
   */
  public setFactors(data: {
    pomScale?: number;
    roughnessFactor?: number;
    metallicFactor?: number;
    emissiveFactor?: number;
    uvXScale?: number;
    uvYScale?: number;
    appearanceBlend?: number;
    surfaceBlend?: number;
    baseColorFactor?: number[];
  }): void {
    if (data.pomScale !== undefined)        this.pomScale        = data.pomScale;
    if (data.roughnessFactor !== undefined) this.roughnessFactor = data.roughnessFactor;
    if (data.metallicFactor !== undefined)  this.metallicFactor  = data.metallicFactor;
    if (data.emissiveFactor !== undefined)  this.emissiveFactor  = data.emissiveFactor;
    if (data.uvXScale !== undefined)        this.uvXScale        = data.uvXScale;
    if (data.uvYScale !== undefined)        this.uvYScale        = data.uvYScale;
    if (data.appearanceBlend !== undefined) this.appearanceBlend = data.appearanceBlend;
    if (data.surfaceBlend !== undefined)    this.surfaceBlend    = data.surfaceBlend;
    if (data.baseColorFactor !== undefined) this.baseColorFactor = data.baseColorFactor;
    this.writeFactorsToGPU();
  }

  /** Writes all in-memory factor values to the active GPU uniform buffer. */
  private writeFactorsToGPU(): void {
    const buf = this.customUniformBuffer ?? this.uniformBuffer;
    if (!buf) return;
    GPUUtils.writeBuffer(buf, 0,  new Float32Array(this.baseColorFactor));
    GPUUtils.writeBuffer(buf, 16, new Float32Array([
      this.roughnessFactor, this.metallicFactor, this.emissiveFactor, this.appearanceBlend,
    ]));
    GPUUtils.writeBuffer(buf, 32, new Float32Array([
      this.uvXScale, this.uvYScale, this.surfaceBlend, this.pomScale,
    ]));
  }

  public override release(): void {
    // Unsubscribe from all engine texture change notifications.
    for (const unsub of this.customUnsubscribes) unsub();
    this.customUnsubscribes = [];
    if (this.customUniformBuffer) {
      this.customUniformBuffer.destroy();
      this.customUniformBuffer = undefined;
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = undefined;
    }
  }
}
