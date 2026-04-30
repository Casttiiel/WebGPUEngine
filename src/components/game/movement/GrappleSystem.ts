import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import { TransformComponent } from '../../core/TransformComponent';

export interface GrappleSystemData {
  /** Maximum range (metres) for the Far Reach raycast. Default 20. */
  grappleMaxDistance?: number;
  /** Target travel time (seconds) from launch to arrival. Default 0.35. */
  grappleTravelTime?: number;
  /** Minimum upward component of the launch direction (prevents flat trajectories). Default 0.2. */
  grappleUpwardBias?: number;
  /** Reduced gravity applied during flight (m/s²). Default -8. */
  grappleFlightGravity?: number;
  /** Brief delay (seconds) between activation and launch — the "reaching" phase. Default 0.1. */
  grappleReachingDuration?: number;
  /** Distance threshold (metres) at which the grapple ends on arrival. Default 0.8. */
  grappleArrivalDistance?: number;
  /** Safety timeout (seconds) before the grapple is forcefully cancelled. Default 2.0. */
  grappleMaxDuration?: number;
}

/** Internal phases of the Far Reach ability (Dishonored 2 style). */
const enum FarReachPhase {
  /** Ability is not active. */
  INACTIVE,
  /**
   * Brief pause before the player is launched (~0.1 s).
   * In full implementations, the "tentacle" VFX extends during this phase.
   */
  REACHING,
  /** Player is flying toward the target with reduced gravity. */
  PULLING,
}

/**
 * GrappleSystem — Far Reach (Dishonored 2 style).
 *
 * Behaviour:
 *  1. REACHING  — short delay after activation (~0.1 s). Player stays still.
 *  2. PULLING   — player receives an initial launch velocity toward the target
 *                 (with an upward bias to create an arc). Reduced gravity is
 *                 applied each frame instead of normal gravity.
 *  3. Arrival   — when the player is within arrivalDistance of the target the
 *                 grapple ends and the controller resumes normal physics.
 *
 * The controller is responsible for:
 *  - Calling tryActivate() from IDLE state when the ability input fires.
 *  - Routing movement through getGrappleVelocity() while GRAPPLING.
 */
export class GrappleSystem {
  private readonly maxDistance: number;
  private readonly travelTime: number;
  private readonly upwardBias: number;
  private readonly flightGravity: number;
  private readonly reachingDuration: number;
  private readonly arrivalDistance: number;
  private readonly maxDuration: number;

  private phase: FarReachPhase = FarReachPhase.INACTIVE;
  private reachingTimer: number = 0;
  private safetyTimer: number = 0;

  private targetPoint: vec3 = vec3.create();
  private startPoint: vec3 = vec3.create();
  /** Velocity applied each frame during PULLING. Gravity accumulates into [1]. */
  private flyVelocity: vec3 = vec3.create();
  /** Last computed velocity, exposed via getGrappleVelocity(). */
  private currentVelocity: vec3 = vec3.create();

  constructor(
    private readonly controller: IMovementController,
    data: GrappleSystemData = {},
  ) {
    this.maxDistance = data.grappleMaxDistance ?? 20;
    this.travelTime = data.grappleTravelTime ?? 0.35;
    this.upwardBias = data.grappleUpwardBias ?? 0.2;
    this.flightGravity = data.grappleFlightGravity ?? -8;
    this.reachingDuration = data.grappleReachingDuration ?? 0.1;
    this.arrivalDistance = data.grappleArrivalDistance ?? 0.8;
    this.maxDuration = data.grappleMaxDuration ?? 2.0;
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /** Maximum reach range in metres — used by the controller for the raycast. */
  public getMaxDistance(): number {
    return this.maxDistance;
  }

  /** World-space position of the player at the moment the grapple was activated. */
  public getStartPoint(): vec3 {
    return this.startPoint;
  }

  /** World-space position of the grapple target. */
  public getTargetPoint(): vec3 {
    return this.targetPoint;
  }

  /**
   * Normalised progress of the current phase:
   *  - INACTIVE  → 0
   *  - REACHING  → 0→1 as the reaching timer elapses
   *  - PULLING   → 1
   */
  public getReachProgress(): number {
    if (this.phase === FarReachPhase.INACTIVE) return 0;
    if (this.phase === FarReachPhase.PULLING) return 1;
    // REACHING: 0 at start, 1 when timer expires
    return 1 - this.reachingTimer / this.reachingDuration;
  }

  /** True while the ability is in REACHING or PULLING phase. */
  public isActive(): boolean {
    return this.phase !== FarReachPhase.INACTIVE;
  }

  /** True only while the player is being pulled toward the target. */
  public isPulling(): boolean {
    return this.phase === FarReachPhase.PULLING;
  }

  /**
   * Activates Far Reach toward the given world-space point.
   * Returns false if the point is beyond maxDistance or another grapple is active.
   */
  public startGrapple(point: vec3): boolean {
    if (this.phase !== FarReachPhase.INACTIVE) return false;

    const playerPos = this.getPlayerPos();
    const dist = vec3.distance(playerPos, point);
    if (dist > this.maxDistance) return false;

    vec3.copy(this.targetPoint, point);
    vec3.copy(this.startPoint, playerPos);

    console.log(
      `[GrappleSystem] START — origin: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${point[0].toFixed(2)}, ${point[1].toFixed(2)}, ${point[2].toFixed(2)})` +
        `  dist: ${dist.toFixed(2)} m`,
    );

    // Compute launch velocity: direction with upward bias, speed = distance / travelTime.
    const toTarget = vec3.subtract(vec3.create(), point, playerPos);
    const launchDir = vec3.normalize(vec3.create(), toTarget);
    launchDir[1] = Math.max(launchDir[1], this.upwardBias);
    vec3.normalize(launchDir, launchDir);

    const speed = dist / this.travelTime;
    vec3.scale(this.flyVelocity, launchDir, speed);

    // Halt current movement so the reach starts cleanly.
    this.controller.setVerticalVelocity(0);
    vec3.zero(this.currentVelocity);

    this.phase = FarReachPhase.REACHING;
    this.reachingTimer = this.reachingDuration;
    this.safetyTimer = this.maxDuration;
    this.controller.setIsGrappling(true);

    return true;
  }

  /**
   * Called every frame while movementState === GRAPPLING.
   * Returns true while active, false when the grapple ends.
   */
  public update(dt: number): boolean {
    if (!this.controller.getIsGrappling()) return false;

    this.safetyTimer -= dt;
    if (this.safetyTimer <= 0) {
      this.endGrapple();
      return false;
    }

    switch (this.phase) {
      case FarReachPhase.REACHING:
        return this.updateReaching(dt);
      case FarReachPhase.PULLING:
        return this.updatePulling(dt);
      default:
        this.endGrapple();
        return false;
    }
  }

  /** Velocity to pass to applyMovement() this frame. */
  public getGrappleVelocity(): vec3 {
    return this.currentVelocity;
  }

  /**
   * Cancels the grapple without calling setIsGrappling on the controller.
   * Use this when an external system has already changed movementState.
   */
  public cancel(): void {
    const playerPos = this.getPlayerPos();
    const target = this.targetPoint;
    console.log(
      `[GrappleSystem] CANCELLED — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
    );
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
    vec3.zero(this.flyVelocity);
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────

  private updateReaching(dt: number): boolean {
    this.reachingTimer -= dt;
    vec3.zero(this.currentVelocity);

    if (this.reachingTimer <= 0) {
      this.phase = FarReachPhase.PULLING;
      const origin = this.startPoint;
      const target = this.targetPoint;
      console.log(
        `[GrappleSystem] PULLING — origin: (${origin[0].toFixed(2)}, ${origin[1].toFixed(2)}, ${origin[2].toFixed(2)})` +
          `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
      );
    }
    return true;
  }

  private updatePulling(dt: number): boolean {
    // Check arrival first.
    const playerPos = this.getPlayerPos();
    const dist = vec3.distance(playerPos, this.targetPoint);
    if (dist <= this.arrivalDistance) {
      const target = this.targetPoint;
      console.log(
        `[GrappleSystem] ARRIVED — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
          `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})  dist: ${dist.toFixed(2)} m`,
      );
      this.endGrapple();
      return false;
    }

    // Apply reduced gravity to the vertical component of the launch velocity.
    this.flyVelocity[1] += this.flightGravity * dt;

    vec3.copy(this.currentVelocity, this.flyVelocity);
    return true;
  }

  private getPlayerPos(): vec3 {
    const t = this.controller
      .getCollider()
      .getOwner()
      .getComponent('transform') as TransformComponent | null;
    return t ? t.getTransform().getWorldPosition() : vec3.create();
  }

  private endGrapple(): void {
    const playerPos = this.getPlayerPos();
    const target = this.targetPoint;
    console.log(
      `[GrappleSystem] END — pos: (${playerPos[0].toFixed(2)}, ${playerPos[1].toFixed(2)}, ${playerPos[2].toFixed(2)})` +
        `  target: (${target[0].toFixed(2)}, ${target[1].toFixed(2)}, ${target[2].toFixed(2)})`,
    );
    this.phase = FarReachPhase.INACTIVE;
    vec3.zero(this.currentVelocity);
    vec3.zero(this.flyVelocity);
    this.controller.setIsGrappling(false);
  }
}
