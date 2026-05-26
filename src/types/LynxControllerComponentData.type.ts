export type LynxControllerComponentDataType = {
  // ── Movement ────────────────────────────────────────────────────────────────
  moveSpeed?: number;
  maxSpeed?: number;
  groundAcceleration?: number;
  groundDeceleration?: number;
  airControl?: number;
  airDrag?: number;

  // ── Jump / gravity ──────────────────────────────────────────────────────────
  jumpHeight?: number;
  jumpTimeToPeak?: number;
  jumpTimeToDescent?: number;
  jumpCutFactor?: number;
  jumpCutVerticalVelocityLimit?: number;
  coyoteTime?: number;
  /** Extra mid-air jumps allowed. 1 = double jump. Default: 1. */
  maxAirJumps?: number;

  // ── Mantle / Vault ──────────────────────────────────────────────────────────
  mantleDetectionDistance?: number;
  mantleMaxHeight?: number;
  minMantleVelocity?: number;
  mantlingMinVerticalVelocity?: number;

  // ── Marker shots ────────────────────────────────────────────────────────────
  /** Max shot charges. Default: 3. */
  markerMaxCharges?: number;
  /** Seconds per charge recharge. Default: 2.5. */
  markerRechargeTime?: number;
  /** Damage per marker shot. Default: 5. */
  markerShotDamage?: number;
  /** Seconds a mark lasts on an enemy. Default: 15. */
  markerMarkDuration?: number;

  // ── Dash punch ──────────────────────────────────────────────────────────────
  /** Dash travel speed (units/s). Default: 28. */
  dashPunchSpeed?: number;
  /** Max travel distance in units. Default: 12. */
  dashPunchMaxDistance?: number;
  /** Damage on hit. Default: 60. */
  dashPunchDamage?: number;
  /** Cooldown in seconds. Default: 10. */
  dashPunchCooldown?: number;

  // ── Misc ────────────────────────────────────────────────────────────────────
  impulsePadInputDisableTime?: number;
};
