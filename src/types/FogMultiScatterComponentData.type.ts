export type FogMultiScatterComponentData = Readonly<{
  enabled?: boolean;
  density?: number;
  heightBase?: number;
  heightFalloff?: number;
  extinctionCoeff?: number;
  scatterColor?: [number, number, number];
  numSteps?: number;
  fogNear?: number;
  fogFar?: number;
  lateralScatterStrength?: number;
  multiScatterStrength?: number;
}>;
