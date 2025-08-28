import { vec3, vec4 } from 'gl-matrix';

export type TransformComponentDataType = {
  position: vec3;
  rotation: vec3;
  quaternion: vec4;
  scale: vec3;
  matrix: number[];
};
