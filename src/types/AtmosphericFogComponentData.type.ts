export interface AtmosphericFogComponentData {
  // Horizon blend fog
  fogColor?: [number, number, number];
  fogDensity?: number;
  fogHeightStart?: number;
  fogHeightEnd?: number;
  fogFalloff?: number;

  // Distance contrast
  distanceFogStart?: number;
  distanceFogEnd?: number;
  distanceExponent?: number;

  // Near fog color override
  nearFogColor?: [number, number, number];
  nearFogStart?: number;
  nearFogEnd?: number;

  // MIP fog (environment cubemap blend)
  mipFogStart?: number;
  mipFogEnd?: number;
  mipFogMaxMip?: number;
  mipFogStrength?: number;

  // Global
  globalAmbientBoost?: number;
}
