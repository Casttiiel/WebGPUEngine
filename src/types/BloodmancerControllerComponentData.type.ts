export type BloodmancerControllerComponentDataType = {
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
  jumpCutFactor?: number;
  jumpCutVerticalVelocityLimit?: number;
  coyoteTime?: number;

  // Mantling
  mantleDetectionDistance?: number;
  mantleMaxHeight?: number;
  minMantleVelocity?: number;
  mantlingMinVerticalVelocity?: number;

  // Impulse pad
  impulsePadInputDisableTime?: number;
};
