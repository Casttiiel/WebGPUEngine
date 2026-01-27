import { vec4 } from 'gl-matrix';
import { CameraComponentDataType } from './CameraComponentData.type';

export interface SpotLightComponentData extends CameraComponentDataType {
  color?: vec4;
  intensity?: number;
  radius?: number;
  isOrtho?: boolean;
  orthoCentered?: boolean;
  orthoLeft?: number;
  orthoWidth?: number;
  orthoTop?: number;
  orthoHeight?: number;
  startFallof?: number;
  hasShadows?: boolean;
  shadowWidth?: number;
  shadowHeight?: number;
  projector?: string;
}
