import { ResourceType } from '../../types/ResourceType.enum';
import { TechniqueMaterialSlot } from '../../types/TechniqueData.type';
import { Material, MaterialTexturesOptions } from './Material';
import { Texture } from './Texture';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { GPUUtils } from '../core/utils/GPUUtils';
import { EngineTextureRegistry } from '../core/utils/EngineTextureRegistry';

export type MaterialInstanceOverrides = {
  baseColorFactor?: number[];
  roughnessFactor?: number;
  metallicFactor?: number;
  emissiveFactor?: number;
  uvXScale?: number;
  uvYScale?: number;
  appearanceBlend?: number;
  surfaceBlend?: number;
  pomScale?: number;
  /** Slot name → texture path overrides. For PBR: txAlbedo, txNormal, etc. */
  textures?: Record<string, string>;
};

/** Maps PBR .mat texture keys to the internal texture Map keys used by Material. */
const PBR_SLOT_MAP: Record<string, string> = {
  txAlbedo: 'albedo',
  txNormal: 'normal',
  txMetallic: 'metallic',
  txRoughness: 'roughness',
  txEmissive: 'emissive',
};

/**
 * A material that inherits its technique and textures from a parent Material,
 * overriding only the specified factor parameters and/or individual texture slots.
 * The technique (pipeline/shaders) is always shared — RenderManager is unaffected.
 *
 * Usage from code:
 *   const inst = await MaterialInstance.from(baseMaterial, { roughnessFactor: 0.1 });
 *
 * Usage from .mat file:
 *   { "parent": "materials/rock.mat", "roughnessFactor": 0.1 }
 */
export class MaterialInstance extends Material {
  private readonly instanceParent: Material;

  private constructor(parent: Material, path: string) {
    super({
      path,
      type: ResourceType.MATERIAL,
      technique: parent.getTechnique()!,
      category: parent.getCategory(),
      castsShadows: parent.getCastsShadows(),
      shadows: parent.getShadows(),
    });
    this.instanceParent = parent;
  }

  /**
   * Creates a MaterialInstance from a loaded parent Material.
   * @param parent   The master material to inherit from.
   * @param overrides Factor and/or texture overrides. Unspecified values are inherited.
   * @param path     Optional resource path; auto-generated if omitted.
   */
  public static async from(
    parent: Material,
    overrides: MaterialInstanceOverrides = {},
    path?: string,
  ): Promise<MaterialInstance> {
    const instancePath = path ?? `${parent.getName()}__instance_${Engine.generateDynamicId()}`;
    const instance = new MaterialInstance(parent, instancePath);
    await instance.initFromParent(parent, overrides);
    return instance;
  }

  /** Overridden to be a no-op — instances are initialised via initFromParent, not load(). */
  public override async load(): Promise<void> {}

  private async initFromParent(
    parent: Material,
    overrides: MaterialInstanceOverrides,
  ): Promise<void> {
    // Merge factors: parent values as base, overrides on top.
    this.baseColorFactor = overrides.baseColorFactor
      ? [...overrides.baseColorFactor]
      : [...parent.getBaseColorFactor()];
    this.roughnessFactor = overrides.roughnessFactor ?? parent.getRoughnessFactor();
    this.metallicFactor = overrides.metallicFactor ?? parent.getMetallicFactor();
    this.emissiveFactor = overrides.emissiveFactor ?? parent.getEmissiveFactor();
    this.uvXScale = overrides.uvXScale ?? parent.getUvXScale();
    this.uvYScale = overrides.uvYScale ?? parent.getUvYScale();
    this.appearanceBlend = overrides.appearanceBlend ?? parent.getAppearanceBlend();
    this.surfaceBlend = overrides.surfaceBlend ?? parent.getSurfaceBlend();
    this.pomScale = overrides.pomScale ?? parent.getPomScale();

    // Share the parent's shadow material (technique is identical).
    if (parent.getCastsShadows()) {
      this.shadowsMaterial = parent.getShadowsMaterial();
    }

    const slots = parent.getTechnique()?.getMaterialSlots();

    if (slots) {
      await this.initCustomSlot(parent, overrides, slots);
    } else {
      await this.initPBR(parent, overrides);
    }
  }

  // ── Custom-slot path ──────────────────────────────────────────────────────

  private async initCustomSlot(
    parent: Material,
    overrides: MaterialInstanceOverrides,
    slots: ReadonlyArray<TechniqueMaterialSlot>,
  ): Promise<void> {
    const parentState = Material.extractMaterialState(parent);

    // Inherit parent's file-based textures and raw texture map.
    this.customSlotTextures = new Map(parentState.customSlotTextures);
    this.rawTextures = { ...parentState.rawTextures };

    // Load and apply texture overrides.
    if (overrides.textures) {
      await Promise.all(
        Object.entries(overrides.textures).map(async ([name, texPath]) => {
          const tex = await Texture.getAsync(texPath, false);
          this.customSlotTextures.set(name, tex);
          this.rawTextures[name] = texPath;
          this.textureViewUnsubs.push(
            tex.addViewListener(() => this.tryBuildCustomBindGroup(slots)),
          );
        }),
      );
    }

    // Subscribe to streaming view-changes for inherited (non-overridden) textures.
    for (const [name, tex] of parentState.customSlotTextures) {
      if (!overrides.textures?.[name]) {
        this.textureViewUnsubs.push(
          tex.addViewListener(() => this.tryBuildCustomBindGroup(slots)),
        );
      }
    }

    // Own uniform buffer with merged factor values.
    this.customUniformBuffer = GPUUtils.createBuffer(
      `${this.path}_ub`,
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.writeFactorsToGPU();

    // Subscribe to engine texture changes so the bind group stays current.
    const rebuild = () => this.tryBuildCustomBindGroup(slots);
    for (const slot of slots) {
      if (slot.type === 'sampler' || slot.type === 'uniform') continue;
      const value = this.rawTextures[slot.name] ?? slot.defaultValue ?? '';
      if (value.startsWith('@engine:')) {
        this.customUnsubscribes.push(EngineTextureRegistry.subscribe(value.slice(1), rebuild));
      }
    }

    this.tryBuildCustomBindGroup(slots);
  }

  // ── Standard PBR path ────────────────────────────────────────────────────

  private async initPBR(
    parent: Material,
    overrides: MaterialInstanceOverrides,
  ): Promise<void> {
    const parentState = Material.extractMaterialState(parent);

    // Inherit parent's texture set.
    this.textures = new Map(parentState.textures);
    this.textureFiles = parentState.textureFiles
      ? { ...parentState.textureFiles }
      : ({
          albedo: 'white.png',
          normal: 'no-normal.jpg',
          metallic: 'black.png',
          roughness: 'black.png',
          emissive: 'black.png',
        } as MaterialTexturesOptions);

    // Load and apply texture overrides.
    if (overrides.textures) {
      await Promise.all(
        Object.entries(overrides.textures).map(async ([slotName, texPath]) => {
          const internalKey = PBR_SLOT_MAP[slotName] ?? slotName;
          const isNormal = internalKey === 'normal';
          const tex = await Texture.getAsync(texPath, isNormal);
          this.textures.set(internalKey, tex);
          this.textureViewUnsubs.push(
            tex.addViewListener(() => void this.rebuildPBRBindGroup()),
          );
        }),
      );
    }

    // Subscribe to streaming view-changes for inherited (non-overridden) textures.
    for (const [type, tex] of parentState.textures) {
      const slotName = Object.entries(PBR_SLOT_MAP).find(([, v]) => v === type)?.[0];
      if (!slotName || !overrides.textures?.[slotName]) {
        this.textureViewUnsubs.push(tex.addViewListener(() => void this.rebuildPBRBindGroup()));
      }
    }

    // Own uniform buffer with merged factor values.
    this.uniformBuffer = GPUUtils.createBuffer(
      `${this.path}_ub`,
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.writeFactorsToGPU();

    await this.rebuildPBRBindGroup();
  }

  private async rebuildPBRBindGroup(): Promise<void> {
    const entries: GPUBindGroupEntry[] = [];
    let idx = 0;

    for (const type of ['albedo', 'normal', 'metallic', 'roughness', 'emissive']) {
      const tex = this.textures.get(type);
      if (!tex) return;
      const view = tex.getTextureView();
      if (!view) return;
      entries.push({ binding: idx++, resource: view });
    }

    const albedo = this.textures.get('albedo');
    if (!albedo) return;
    const sampler = albedo.getSampler();
    if (!sampler) return;
    entries.push({ binding: idx++, resource: sampler });

    if (!this.uniformBuffer) return;
    entries.push({ binding: 6, resource: { buffer: this.uniformBuffer } });

    this.textureBindGroup = BindGroupFactory.createBindGroup(
      `${this.path}_bg`,
      BindGroupFactory.getLayoutFromEnum(PipelineBindGroupLayouts.MATERIAL_TEXTURES),
      entries,
    );
  }

  /** Returns the parent material this instance was created from. */
  public getParent(): Material {
    return this.instanceParent;
  }
}
