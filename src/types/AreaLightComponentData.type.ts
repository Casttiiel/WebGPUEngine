export interface AreaLightComponentData {
  color?: [number, number, number];
  intensity?: number;
  /** Full width of the light rectangle in world units (default 1.0) */
  width?: number;
  /** Full height of the light rectangle in world units (default 1.0) */
  height?: number;
  /** Maximum influence radius in world units (default 10.0) */
  radius?: number;
  /** Distance at which the smooth falloff begins (default radius * 0.5) */
  startFalloff?: number;
  /** Whether the light illuminates from both sides (default false) */
  twoSided?: boolean;
}
