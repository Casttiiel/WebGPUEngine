export interface FogVolumeComponentData {
  shape?: 'box' | 'sphere';
  /** Half-extents for box volumes [x, y, z]. Default: [5, 5, 5] */
  size?: [number, number, number];
  /** Radius for sphere volumes. Default: 5 */
  radius?: number;
  /** Base density multiplier inside the volume. Default: 0.5 */
  density?: number;
  /** Scattering coefficient (controls how much light scatters). Default: 1.0 */
  scatteringCoeff?: number;
  /** Absorption coefficient (controls how much light is absorbed). Default: 0.2 */
  absorptionCoeff?: number;
  /** Falloff distance in world units at the volume boundary. Default: 2.0 */
  falloff?: number;
  /**
   * Blend mode:
   *   "add"      — adds density on top of the global height fog
   *   "override" — lerps toward the volume's density (clears fog in interiors)
   */
  blendMode?: 'add' | 'override';
  /** Irregularidad (0 = uniforme, 1 = jirones con huecos finos, al 35 %). Default 0. */
  noiseAmount?: number;
  /** Frecuencia del ruido (1/m): 0.25 → bancos de unos 4 m. Default 0.25. */
  noiseScale?: number;
  /** Velocidad a la que deriva y evoluciona (m/s; se suma al viento del motor). Default 0.4. */
  noiseSpeed?: number;
  /** El borde superior ondula en vez de ser plano (0..1). Default 0. */
  edgeBreakup?: number;
}
