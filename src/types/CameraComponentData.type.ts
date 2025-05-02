import { vec3 } from "gl-matrix";

export type CameraComponentDataType = Readonly<{
    near: number;
    far: number;
    fov: number;
    viewport: {
        width: number;
        height: number;
    },
    position: vec3;
    target: vec3;
    up: vec3;
    controllable: boolean;
}>;