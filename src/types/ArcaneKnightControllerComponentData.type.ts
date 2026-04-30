export type ArcaneKnightControllerComponentDataType = {
  // Movement
  moveSpeed?: number;
  maxSpeed?: number;
  groundAcceleration?: number;
  groundDeceleration?: number;
  airControl?: number;
  airDrag?: number;

  // Jump / gravity
  jumpHeight?: number;
  jumpTimeToPeak?: number;
  jumpTimeToDescent?: number;
  coyoteTime?: number;

  // Combat
  dashDistance?: number;
  dashDuration?: number;
  lightAttackDuration?: number;
  heavyAttackDuration?: number;
  parryWindow?: number;

  // Mantling
  mantleDetectionDistance?: number;
  mantleMaxHeight?: number;
  minMantleVelocity?: number;
  mantlingMinVerticalVelocity?: number;

  // Dodge
  dodgeSpeed?: number;
  dodgeDuration?: number;
  dodgeCooldown?: number;
  dodgeStaminaCost?: number; // Stamina cost per dodge (default: 0)

  // Throwing daggers
  daggerMaxCharges?: number;
  daggerRegenTime?: number;
  daggerPoolName?: string;

  // Grapple (Far Reach)
  grappleMaxDistance?: number;
  grappleTravelTime?: number;
  grappleUpwardBias?: number;
  grappleFlightGravity?: number;
  grappleReachingDuration?: number;
  grappleArrivalDistance?: number;
  grappleMaxDuration?: number;

  // Wall kick
  wallKickDetectionDistance?: number;
  wallKickInputDisableTime?: number;

  // Impulse pad
  impulsePadInputDisableTime?: number;
};
