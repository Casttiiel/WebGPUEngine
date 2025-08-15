import { vec3 } from 'gl-matrix';

export type CameraComponentDataType = Readonly<{
  near?: number;
  far?: number;
  fov?: number;
  ortho?: boolean;
  orthoWidth?: number;
  orthoHeight?: number;
  orthoLeft?: number;
  orthoTop?: number;
  orthoCentered?: boolean;
  viewport?: {
    width: number;
    height: number;
  };
  position?: vec3;
  target?: vec3;
  up?: vec3;
  controllable?: boolean;
}>;
