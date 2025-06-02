import { RenderComponentDataType } from "./RenderComponentData.type";
import { TransformComponentDataType } from "./TransformComponentData.type";

export type SceneDataType = ReadonlyArray<EntityDataType>;

export type EntityDataType = {
    children?: Array<EntityDataType>;
    components: {
        transform?: TransformComponentDataType;
        render?: RenderComponentDataType;
        name?: string;
    };
    prefab?: string;
    gltf?: string;
};
