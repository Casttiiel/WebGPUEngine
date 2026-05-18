/**
 * BestialitySystem — Bloodmancer passive that tracks combat aggression.
 *
 * Value (0–100) rises every time the player deals damage and decays to 0
 * after a period of inactivity:
 *
 *   • Gain : +gainPerShot on each dagger fired (via onDamageDealt()).
 *             +proportional gain from blood-zone ticks (via static notify()).
 *   • Hold  : value stays at its peak while damage is dealt at least once
 *             every `decayDelay` seconds (default 5 s).
 *   • Decay : after `decayDelay` seconds without damage the value drains
 *             linearly to 0 over `decayDuration` seconds (default 2 s).
 *
 * Effect on fire rate:
 *   getCooldownMultiplier() returns a value in [0.5, 1.0]:
 *     0 % bestiality → ×1.0 (normal cooldown)
 *   100 % bestiality → ×0.5 (half cooldown = double fire rate)
 *
 * Since BloodZoneComponent is spawned dynamically from JSON (no direct ref),
 * it communicates through the static notify() / activeInstance pattern.
 */
export class BestialitySystem {
  // ─── Static notification point ───────────────────────────────────────────
  // BloodZoneComponent has no direct reference to the owning controller,
  // so it calls BestialitySystem.notify() which forwards to the active instance.
  public static activeInstance: BestialitySystem | null = null;

  /** Called by any system when the player deals damage (e.g. BloodZoneComponent). */
  public static notify(gain: number): void {
    BestialitySystem.activeInstance?.onDamageDealt(gain);
  }

  // ─── Configuration ────────────────────────────────────────────────────────
  private readonly maxValue: number = 100;
  /** Default gain per direct hit / shot. */
  private readonly gainPerShot: number;
  /** Seconds without damage before decay begins. */
  private readonly decayDelay: number;
  /** Value drained per second once decay is active (= maxValue / decayDuration). */
  private readonly decayRate: number;

  // ─── Runtime state ────────────────────────────────────────────────────────
  private value: number = 0;
  private timeSinceLastDamage: number = 0;

  // ─────────────────────────────────────────────────────────────────────────

  constructor(data?: {
    /** Bestiality gain per dagger shot. Default 10. */
    gainPerShot?: number;
    /** Seconds without damage before decay starts. Default 5. */
    decayDelay?: number;
    /** Seconds for the value to drain from full (100) to 0 once decay starts. Default 2. */
    decayDuration?: number;
  }) {
    this.gainPerShot = data?.gainPerShot ?? 10;
    this.decayDelay = data?.decayDelay ?? 5;
    const decayDuration = data?.decayDuration ?? 2;
    this.decayRate = this.maxValue / decayDuration; // 50 / second by default
  }

  // ─── Per-frame update ────────────────────────────────────────────────────

  public update(dt: number): void {
    this.timeSinceLastDamage += dt;

    if (this.value > 0 && this.timeSinceLastDamage >= this.decayDelay) {
      this.value = Math.max(0, this.value - this.decayRate * dt);
    }
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * Call whenever the player deals damage.
   * @param gain Amount to add. Defaults to gainPerShot (for dagger hits).
   *             BloodZone passes a smaller proportional value.
   */
  public onDamageDealt(gain: number = this.gainPerShot): void {
    this.timeSinceLastDamage = 0;
    this.value = Math.min(this.maxValue, this.value + gain);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * Cooldown multiplier to apply to DaggerBurstSystem:
   *   0 %  → 1.0 (normal speed)
   *   100% → 0.5 (double speed)
   */
  public getCooldownMultiplier(): number {
    return 1.0 - 0.5 * (this.value / this.maxValue);
  }

  /** Raw value in [0, 100]. */
  public getValue(): number {
    return this.value;
  }

  /** Normalised value in [0, 1]. */
  public getNormalizedValue(): number {
    return this.value / this.maxValue;
  }
}
