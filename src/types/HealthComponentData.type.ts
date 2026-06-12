export type HealthComponentDataType = {
  maxHp?: number; // Maximum hit points (default: 100)
  invincibilityTime?: number; // Seconds of invincibility after taking damage (default: 0)
  /**
   * Fraction of incoming damage absorbed (0 = no resistance, 0.8 = takes 20% damage).
   * Bypassed when Msg.damage has sourceTag: 'bypass_resistance'. Default: 0
   */
  damageResistance?: number;
  /**
   * Faction tag for friendly-fire prevention (e.g. 'enemy', 'player').
   * Damage from an instigator with the same faction is ignored.
   * Leave undefined (default) to receive damage from everyone — useful for training dummies.
   */
  faction?: string;
};
