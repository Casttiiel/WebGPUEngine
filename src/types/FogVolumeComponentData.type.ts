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
}
