export type FogScatterComponentData = Readonly<{
  enabled?: boolean;
  // Raymarch
  density?: number;
  heightBase?: number;
  heightFalloff?: number;
  extinctionCoeff?: number;
  scatterColor?: [number, number, number];
  numSteps?: number;
  fogNear?: number;
  fogFar?: number;
  // Fog bilateral blur (denoising)
  fogBlurRadius?: number;
  fogDepthSigma?: number;
  // Noise / wind
  noiseScale?: number;
  noiseStrength?: number;
  windSpeed?: number;
  windAngle?: number;
  fogBaseColor?: [number, number, number];
  noiseThreshold?: number;
  noiseWarp?: number;
  // Bounded fog slab (layerHeight 0 = unbounded exponential height fog)
  layerHeight?: number;
  layerFalloff?: number;
  // Sun phase function (Henyey-Greenstein g)
  anisotropy?: number;
  // JBU upsample of the half-res fog
  upsampleDepthSensitivity?: number;
  // SSMS compose
  maxDensity?: number;
  energyLoss?: number;
  // SSMS pyramid
  blurTint?: [number, number, number];
  blurWeight?: number;
  scatterIntensity?: number;
  scatterRadius?: number;
  fadeCurve?: number;
  threshold?: number;
  softKnee?: number;
}>;
