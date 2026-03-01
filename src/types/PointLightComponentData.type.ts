import { vec4 } from 'gl-matrix';

export interface PointLightComponentData {
  color?: vec4;
  intensity?: number;
  radius?: number;
  startFallof?: number;
  hasShadows?: boolean;
  shadowResolution?: number; // Face resolution in pixels (default 512)
}
