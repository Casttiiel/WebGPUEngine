export type FogScatterComponentData = Readonly<{
  enabled?: boolean;
  density?: number;
  heightBase?: number;
  heightFalloff?: number;
  extinctionCoeff?: number;
  scatterColor?: [number, number, number];
  numSteps?: number;
  fogNear?: number;
  fogFar?: number;
  ambientColor?: [number, number, number];
  ambientStrength?: number;
  lateralScatterStrength?: number;
  scatterStrength?: number;
}>;
