import { RenderCategory } from "../renderer/core/render_category.enum";

export type MaterialDataType = Readonly<{
    technique: string;
    textures: ReadonlyArray<MaterialTextureDataType>;
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