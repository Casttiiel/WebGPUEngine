import { vec3 } from "gl-matrix";

export type TransformComponentDataType = Readonly<{
    position: vec3;
    rotation: vec3;
    scale: vec3;
}>;