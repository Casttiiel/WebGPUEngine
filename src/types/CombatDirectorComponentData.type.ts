export interface CombatDirectorComponentData {
  /**
   * Starting aggressiveness level (0–1). Drives both simultaneous attacker count
   * and the pace between attack cycles. Scales up over time if the player is not hit.
   * Default: 0.5
   */
  aggressiveness?: number;
  /**
   * Base number of enemies that can hold an attack token simultaneously at aggressiveness=0.
   * At aggressiveness=1 this scales up to baseMaxAttackers+2.
   * Default: 1
   */
  baseMaxAttackers?: number;
  /**
   * Milliseconds the director waits after ALL active attackers finish before
   * granting the next attack wave. Lower = more relentless.
   * Default: 1500
   */
  attackPaceMs?: number;
}
