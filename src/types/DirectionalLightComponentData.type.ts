export interface DirectionalLightComponentData {
  near?: number;
  far?: number;
  orthoWidth?: number;
  orthoHeight?: number;
  hasShadows?: boolean;
  color?: number[];
  intensity?: number;
  position: number[];
  target: number[];
  // CSM configuration
  cascadeCount?: number; // 1, 2, or 3 cascades (default: 1)
  cascadeLambda?: number; // 0-1: 0=uniform, 1=logarithmic (default: 0.5)
}
