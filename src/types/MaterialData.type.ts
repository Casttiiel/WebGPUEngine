import { RenderCategory } from './RenderCategory.enum';
import { TechniqueDataType } from './TechniqueData.type';

export type MaterialDataType = Readonly<{
  /** Path to a parent material. When set, this material becomes an instance that inherits
   *  the parent's technique and textures, overriding only the specified factors/textures. */
  parent?: string;
  technique?: string;
  techniqueData?: TechniqueDataType;
  baseColorFactor?: number[];
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: number;
  uvXScale?: number;
  uvYScale?: number;
  /** Decal blend weight for albedo + normal channels. 1 = full blend, 0 = no change. Default 1. */
  appearanceBlend?: number;
  /** Decal blend weight for roughness + metallic channels. 1 = full blend, 0 = no change. Default 1. */
  surfaceBlend?: number;
  /** Parallax Occlusion Mapping height scale. 0 = disabled (default). Typical range 0.01–0.1. */
  pomScale?: number;
  /**
   * Extra parameters (pomShadow, layerCoverage, cavityDirt, …): any key listed in
   * renderer/resources/MaterialExtras.ts, set at the top level of the .mat.
   */
  [extra: string]: unknown;
  /**
   * Shader features of this material's technique permutation, e.g. ["BOX", "SILHOUETTE"]:
   * the technique is compiled with these #defines (and its `variants` for them).
   */
  features?: ReadonlyArray<string>;
  /**
   * PBR materials use the named keys (txAlbedo, txNormal, …).
   * Custom-slot materials use arbitrary keys that match their technique's materialSlots.
   * Optional at the type level — custom materials may omit slots covered by defaultValue.
   */
  textures?: MaterialTextureDataType;
  casts_shadows?: boolean;
  category: RenderCategory;
  shadows?: boolean;
}>;

export type MaterialTextureDataType = Readonly<{
  txAlbedo?: string;
  txNormal?: string;
  txMetallic?: string;
  txRoughness?: string;
  txEmissive?: string;
  /** Allow arbitrary keys for custom material slot declarations. */
  [key: string]: string | undefined;
}>;
