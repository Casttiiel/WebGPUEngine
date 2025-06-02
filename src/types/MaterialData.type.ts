import { RenderCategory } from "../renderer/core/render_category.enum";
import { TechniqueDataType } from "./TechniqueData.type";

export type MaterialDataType = Readonly<{
    technique?: string;
    techniqueData?: TechniqueDataType;
    textures: MaterialTextureDataType;
    casts_shadows: boolean;
    category: RenderCategory;
    shadows: boolean;
}>;

type MaterialTextureDataType = Readonly<{
    txAlbedo?: string;
    txNormal?: string;
    txMetallic?: string;
    txRoughness?: string;
    txEmissive?: string;
}>;