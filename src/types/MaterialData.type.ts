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
