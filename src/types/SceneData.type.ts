import { RenderComponentDataType } from "./RenderComponentData.type";
import { TransformComponentDataType } from "./TransformComponentData.type";

export type SceneDataType = ReadonlyArray<EntityDataType>;

export type EntityDataType = Readonly<{
    name: string;
    children: ReadonlyArray<EntityDataType>;
    components: Readonly<{
        transform?: TransformComponentDataType;
        render?: RenderComponentDataType;
    }>;
}>;
