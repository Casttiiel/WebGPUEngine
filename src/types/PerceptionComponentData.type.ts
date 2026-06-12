export interface PerceptionComponentDataType {
  /** Maximum distance at which the enemy can see the player (metres). Default: 20 */
  sightRadius?: number;
  /** Radius for passive hearing — no LOS required (metres). Default: 8 */
  hearRadius?: number;
  /** Horizontal field-of-view cone for sight (degrees). Default: 120 */
  fovDegrees?: number;
  /**
   * Eye ray origin height relative to the rigid body CENTER (capsule midpoint), in metres.
   * For a 1.8m capsule (centre ~0.9m from ground), 0.7 places the eye at ~1.6m from ground.
   * Default: 0.7
   */
  eyeHeightOffset?: number;
  /**
   * How often perception checks run (seconds). Default: 0.1 (10 Hz).
   * Reduce for performance with many enemies.
   */
  checkInterval?: number;
  /**
   * Component key used to identify the player entity.
   * Default: 'player_controller'
   */
  playerComponentKey?: string;
  /**
   * Once the player is spotted (full FOV+LOS check), the enemy enters "combat state"
   * and keeps tracking the player with no FOV or LOS requirement until the player
   * moves farther than this distance. H&S style — enemies don't lose you mid-fight.
   * Default: 25 (metres)
   */
  deaggroRadius?: number;
}
