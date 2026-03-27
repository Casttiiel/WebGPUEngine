import { RenderCategory } from './RenderCategory.enum';
import { TechniqueDataType } from './TechniqueData.type';

export type MaterialDataType = Readonly<{
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
  textures: MaterialTextureDataType;
  casts_shadows?: boolean;
  category: RenderCategory;
  shadows?: boolean;
}>;

type MaterialTextureDataType = Readonly<{
  txAlbedo?: string;
  txNormal?: string;
  txMetallic?: string;
  txRoughness?: string;
  txEmissive?: string;
}>;
