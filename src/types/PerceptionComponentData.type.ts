export interface PerceptionComponentDataType {
  /** Maximum distance at which the enemy can see the player (metres). Default: 20 */
  sightRadius?: number;
  /** Radius for passive hearing — no LOS required (metres). Default: 8 */
  hearRadius?: number;
  /** Horizontal field-of-view cone for sight (degrees). Default: 120 */
  fovDegrees?: number;
  /** Ray origin height above the capsule base (metres). Default: 1.6 */
  eyeHeightOffset?: number;
  /**
   * How often perception checks run (seconds). Default: 0.1 (10 Hz).
   * Reduce for performance with many enemies.
   */
  checkInterval?: number;
  /**
   * Component key used to identify the player entity.
   * Default: 'character_controller'
   */
  playerComponentKey?: string;
}
