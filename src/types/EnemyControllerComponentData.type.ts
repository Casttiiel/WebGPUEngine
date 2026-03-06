export interface EnemyControllerComponentDataType {
  /** Movement speed in m/s. Default: 3.5 */
  moveSpeed?: number;
  /** Gravity acceleration in m/s². Default: 20 */
  gravity?: number;
  /** Exponential acceleration factor for horizontal movement. Default: 10 */
  acceleration?: number;
}
