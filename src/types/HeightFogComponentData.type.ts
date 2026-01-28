// Datos configurables para HeightFogComponent
export interface HeightFogComponentData {
  color?: [number, number, number, number]; // RGBA
  density?: number;
  height?: number;
  heightFalloff?: number;
  start?: number;
  end?: number;
  scattering?: number;
}
