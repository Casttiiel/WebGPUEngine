export interface EnemyControllerComponentDataType {
  /** Movement speed in m/s. Default: 3.5 */
  moveSpeed?: number;
  /** Gravity acceleration in m/s². Default: 20 */
  gravity?: number;
  /** Exponential acceleration factor for horizontal movement. Default: 10 */
  acceleration?: number;
  /** Maximum rotation speed in degrees/second. Default: 240 */
  turnSpeed?: number;
  /** |vy| (m/s) below which apex gravity applies. 0 = disabled. Default: 0. */
  apexThreshold?: number;
  /** Gravity multiplier inside the apex zone. < 1 = hang time. Default: 1.0. */
  apexGravityScale?: number;
  /** Gravity multiplier during descent (outside apex zone). > 1 = heavier fall. Default: 1.0. */
  fallGravityScale?: number;
  /**
   * Gravity multiplier during knockback ascent (after a kick/impulse with vy > 0).
   * < 1 = floaty kick arc (Dark Messiah style). Default: 1.0.
   */
  knockbackAscendScale?: number;
}
