export type CharacterControllerComponentDataType = {
  moveSpeed?: number; // Movement speed in units per second (default: 5.0)
  maxSpeed?: number; // Maximum horizontal speed in units per second (default: 10.0)
  airControl?: number; // Air control strength (0.0 = no control, 1.0 = full control, default: 0.3)
  groundAcceleration: number; // Time to reach max speed on ground in seconds (default: 0.1)
  groundDeceleration: number; // Time to stop completely on ground in seconds (default: 0.1)
  airDrag: number; // Air drag factor (0.0 = no drag, 1.0 = full stop, default: 0.1)

  jumpHeight?: number; // Jump height in units (default: 2.0)
  jumpTimeToPeak?: number; // Time to reach jump apex in seconds (default: 0.5)
  jumpTimeToDescent?: number; // Time to fall from apex to ground in seconds (default: 0.5)
  jumpCutFactor?: number; // Factor to reduce jump height when cutting jump (0.0 = no cut, 1.0 = full cut, default: 0.5)
  jumpCutVerticalVelocityLimit?: number; // Max vertical velocity to allow jump cut (default: 1.0)
  coyoteTime?: number; // Grace period to jump after leaving ground in seconds (default: 0.15)

  slideMinStartSpeedThreshold?: number; // Minimum speed to activate slide (default: 5.0)
  minSlideVelocityThreshold?: number; // Minimum speed to maintain slide (default: 2.0)
  slideDownhillAccel?: number; // Slide deceleration time in seconds (default: 4.0)
  slideFriction?: number; // Base slide friction (default: 4.0)
  slideUphillBrake?: number; // Additional friction when sliding uphill (default: 5.0)
  slideMinDuration?: number; // Minimum slide duration before it can be cancelled in seconds (default: 0.5)

  wallRunGravity?: number; // Gravity multiplier when wall running (default: 0.5)
  startWallRunGravity?: number; // Initial vertical velocity when starting a wall run (default: 2.5)
  wallRunAcceleration?: number; // Time to reach max speed while wall running in seconds (default: 0.2)
  detectWallDistance?: number; // Distance to detect walls for wall running (default: 1.0)

  wallJumpForce?: number; // Wall jump vertical force (default: 8.0)
  wallJumpCoyoteTime?: number; // Grace period to wall jump after leaving a wall in seconds (default: 0.15)
  disableInputAfterWallJumpTime?: number; // Time to disable input after wall jump in seconds (default: 0.2)
  disableMantleAfterWallJumpTime?: number; // Time to disable mantling after wall jump in seconds (default: 0.3)

  mantleDetectionDistance?: number; // Distance to detect mantleable ledges (default: 1.5)
  mantleMaxHeight?: number; // Maximum height of mantleable ledges (default: 2.0)
  mantlingMinVerticalVelocity?: number; // Minimum vertical velocity to allow mantling (default: -5.0)
  minMantleVelocity?: number; // Minimum velocity when starting a mantle (default: 8.0)

  divingGravityMultiplier?: number; // Gravity multiplier when diving (default: 4.0)

  minSwingSpeed?: number; // Minimum speed to start swinging (default: 2.0)

  impulsePadInputDisableTime?: number; // Time to disable input after impulse pad in seconds (default: 0.5)
};
