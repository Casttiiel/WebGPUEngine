export interface AmbientEnvironmentData {
  globalFactor: number;
  diffuseFactor: number;
  reflectionFactor: number;
  /** Scale of the reflected environment only (IBL + SSR misses), like three.js' SSRNode.environmentIntensity. */
  environmentIntensity: number;
}
