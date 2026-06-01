import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../../core/ecs/Component';
import type { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import { Engine } from '../../../core/engine/Engine';

// ── Private helper ────────────────────────────────────────────────────────────
/** Moves `current` toward `target` by at most `delta`, never overshooting. */
function approach(current: number, target: number, delta: number): number {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return current;
}

// ── Params ────────────────────────────────────────────────────────────────────

export interface KCCMovementParams {
  // ── Horizontal movement ───────────────────────────────────────────────────
  /** Normal max horizontal speed (m/s). Default (CMC): 11. */
  maxSpeed?: number;
  /** Ground acceleration (m/s²) in CMC mode. Also accepted as `acceleration`. Default (CMC): 36. */
  groundAcceleration?: number;
  /** Ground deceleration when no input (m/s²). Default (CMC): 18. */
  groundDeceleration?: number;
  /**
   * Fraction of groundAcceleration available in the air.
   * Default (CMC): 0.65. Default (legacy): 0.4.
   */
  airControl?: number;
  /**
   * Per-second air drag coefficient when airborne with no input.
   * CMC mode: v *= (1 - airDrag)^dt.  Default (CMC): 0.3.
   * Legacy mode: v *= exp(-airDrag * dt). Default (legacy): 1.5.
   */
  airDrag?: number;

  // ── Jump (CMC mode only) ──────────────────────────────────────────────────
  /** Max jump height (m). Default: 2.2. */
  jumpHeight?: number;
  /** Seconds from jump start to apex. Default: 0.5. */
  jumpTimeToPeak?: number;
  /** Seconds from apex to ground. Default: 0.4. */
  jumpTimeToDescent?: number;
  /**
   * Gravity multiplier applied at the jump apex
   * when `isJumping && vy > 0 && vy < jumpCutVelocityLimit`.
   * < 1 creates a floaty peak. Clear with `releaseJump()` for variable height.
   * Default: 0.7.
   */
  jumpCutFactor?: number;
  /** vy threshold (m/s) below which jumpCutFactor is active at apex. Default: 1.0. */
  jumpCutVelocityLimit?: number;
  /** Seconds after leaving the ground where a jump can still trigger. Default: 0.12. */
  coyoteTime?: number;
  /** Extra mid-air jumps (0 = single, 1 = double jump). Default: 0. */
  maxAirJumps?: number;

  // ── Legacy / simple gravity (enemy style) ─────────────────────────────────
  /**
   * Constant gravity magnitude (m/s²). Overrides jump-derived gravity.
   * Providing this (without jumpHeight) enables legacy exponential-acceleration mode.
   */
  gravity?: number;
  /** Alias for groundAcceleration (legacy enemy usage). */
  acceleration?: number;
}

/**
 * KCCMovement — Kinematic Character Controller Movement.
 *
 * A self-contained velocity integration system analogous to Unreal Engine's
 * UCharacterMovementComponent. Handles ground/air movement, gravity, jumping
 * (coyote time, air jumps, variable-height apex), impulses, and KCC application.
 *
 * **CMC mode** (player): provide jump params (`jumpHeight`, etc.) or `maxSpeed`.
 * Horizontal movement uses linear acceleration (`approach`), two-phase gravity.
 * ```ts
 * this.movement = new KCCMovement({
 *   maxSpeed: 11, groundAcceleration: 65, groundDeceleration: 65,
 *   airControl: 0.65, airDrag: 0.3,
 *   jumpHeight: 1.3, jumpTimeToPeak: 0.38, jumpTimeToDescent: 0.32,
 *   jumpCutFactor: 0.7, jumpCutVelocityLimit: 1.0, coyoteTime: 0.15,
 *   maxAirJumps: 1,
 * });
 * // jump press: this.movement.requestJump()
 * // jump release: this.movement.releaseJump()
 * // each frame (IDLE): this.movement.update(dt, dir * maxSpeed, isGrounded)
 * //                    this.movement.applyViaKCC(dt, capsule, kcc)
 * // override states:  this.movement.setVelocity(v); this.movement.applyViaKCC(...)
 * ```
 *
 * **Legacy mode** (enemies): provide `gravity` without `jumpHeight`.
 * Horizontal uses exponential approach (original behaviour preserved).
 * ```ts
 * this.movement = new KCCMovement({ gravity: 9, acceleration: 8 });
 * this.movement.update(dt, dir * moveSpeed, isGrounded);
 * this.movement.applyViaKCC(dt, capsule, kcc);
 * ```
 */
export class KCCMovement extends Component {
  // ── Mode flag ──────────────────────────────────────────────────────────────
  /** True when only gravity/acceleration were provided — preserves original exponential behaviour. */
  private isLegacyMode: boolean = false;

  // ── Physics constants ──────────────────────────────────────────────────────
  private jumpVelocity: number = 0;
  /** Applied while vy > 0 (ascending). Negative. */
  private ascendGravity: number = -20;
  /** Applied while vy <= 0 (descending). Negative, stronger. */
  private descendGravity: number = -20;
  private jumpCutFactor: number = 0.7;
  private jumpCutVelocityLimit: number = 1.0;
  private coyoteTime: number = 0.12;
  private maxAirJumps: number = 0;

  // ── Movement params ────────────────────────────────────────────────────────
  private _maxSpeed: number = 11.0;
  private groundAcceleration: number = 36;
  private groundDeceleration: number = 18;
  private airControl: number = 0.65;
  private airDrag: number = 0.3;

  // ── Velocity state ─────────────────────────────────────────────────────────
  private vx = 0;
  private vy = 0;
  private vz = 0;

  // ── Jump state ─────────────────────────────────────────────────────────────
  private isJumpingFlag = false;
  private airJumpsUsed = 0;
  /** Seconds since the character last had isGrounded = true. */
  private timeSinceGrounded = 0;

  // ── Gravity scale (e.g. wall-run) ──────────────────────────────────────────
  private gravityScale = 1.0;

  // ── Grounded state (updated via updateGroundedState) ──────────────────────
  private _isGrounded = false;
  private _groundNormal: vec3 = vec3.fromValues(0, 1, 0);

  // ── Cache ──────────────────────────────────────────────────────────────────
  private readonly _hVel: vec3 = vec3.create();

  constructor(params: KCCMovementParams = {}) {
    super();
    this.initialize(params);
  }

  /** Called by the Loader when used as an ECS component. */
  public load(data: unknown): void {
    this.initialize((data as KCCMovementParams) ?? {});
  }

  /** ECS tick — no-op. Integration is driven by the controller via `integrate()`. */
  public update(_dt: number): void {}

  public renderDebug(): void {}

  // ── Initialization ───────────────────────────────────────────────────────────────

  private initialize(params: KCCMovementParams): void {
    // Detect legacy mode: gravity provided, no jump kinematics.
    this.isLegacyMode = params.gravity !== undefined && params.jumpHeight === undefined;

    this._maxSpeed = params.maxSpeed ?? 11.0;

    // Acceleration — accept `acceleration` as alias for groundAcceleration.
    const accel = params.groundAcceleration ?? params.acceleration ?? (this.isLegacyMode ? 10 : 36);
    this.groundAcceleration = accel;

    // Deceleration: legacy uses same rate as accel; CMC has separate default.
    this.groundDeceleration = params.groundDeceleration ?? (this.isLegacyMode ? accel : 18);

    // Air params: different defaults per mode.
    this.airControl = params.airControl ?? (this.isLegacyMode ? 0.4 : 0.65);
    this.airDrag = params.airDrag ?? (this.isLegacyMode ? 1.5 : 0.3);

    // Jump constants.
    this.coyoteTime = params.coyoteTime ?? 0.12;
    this.maxAirJumps = params.maxAirJumps ?? 0;
    this.jumpCutFactor = params.jumpCutFactor ?? 0.7;
    this.jumpCutVelocityLimit = params.jumpCutVelocityLimit ?? 1.0;

    if (params.gravity !== undefined) {
      // Simple constant gravity (legacy enemies or CMC with override).
      this.ascendGravity = -params.gravity;
      this.descendGravity = -params.gravity;
      this.jumpVelocity = 0;
    } else {
      // Kinematic jump formulas.
      const h = params.jumpHeight ?? 2.2;
      const tp = params.jumpTimeToPeak ?? 0.5;
      const td = params.jumpTimeToDescent ?? 0.4;
      this.jumpVelocity = (2.0 * h) / tp;
      this.ascendGravity = -(2.0 * h) / (tp * tp);
      this.descendGravity = -(2.0 * h) / (td * td);
    }
  }

  // ── Jump API ───────────────────────────────────────────────────────────────

  /**
   * Request a jump (call on button press / buffer hit).
   * Handles ground jump, coyote-time window, and air jumps automatically.
   * @returns `true` if a jump was initiated.
   */
  public requestJump(): boolean {
    const canGroundJump = !this.isJumpingFlag && this.timeSinceGrounded < this.coyoteTime;
    if (canGroundJump) {
      this.vy = this.jumpVelocity;
      this.isJumpingFlag = true;
      // Burn coyote window so a second tap doesn't re-trigger.
      this.timeSinceGrounded = this.coyoteTime + 1.0;
      return true;
    }
    if (this.airJumpsUsed < this.maxAirJumps) {
      this.vy = this.jumpVelocity;
      this.airJumpsUsed++;
      this.isJumpingFlag = true;
      return true;
    }
    return false;
  }

  /**
   * Notify that the jump button was released.
   * Clears `isJumpingFlag`, which removes the floaty-apex gravity reduction
   * and produces a lower peak when released early (variable-height jumping).
   */
  public releaseJump(): void {
    this.isJumpingFlag = false;
  }

  /**
   * Unconditionally apply the jump velocity impulse.
   * Used by external systems (e.g. wall-kick, impulse pads) that bypass the
   * normal jump-state checks.
   */
  public applyJump(): void {
    this.vy = this.jumpVelocity;
    this.isJumpingFlag = true;
  }

  // ── Velocity overrides ─────────────────────────────────────────────────────

  /** Add an instantaneous velocity impulse (knockback, hits). Always additive. */
  public applyImpulse(impulse: vec3): void {
    this.vx += impulse[0];
    this.vy += impulse[1];
    this.vz += impulse[2];
  }

  /**
   * Override the full velocity vector.
   * Use for states that drive movement directly (dash, mantle, vault).
   */
  public setVelocity(v: vec3): void {
    this.vx = v[0];
    this.vy = v[1];
    this.vz = v[2];
  }

  /** Override horizontal components only (X and Z). Preserves current vy. */
  public setHorizontalVelocity(v: vec3): void {
    this.vx = v[0];
    this.vz = v[2];
  }

  /** Suma a los componentes horizontales sin tocar vy. */
  public addHorizontalVelocity(v: vec3): void {
    this.vx += v[0];
    this.vz += v[2];
  }

  public setVerticalVelocity(v: number): void {
    this.vy = v;
  }

  public getVerticalVelocity(): number {
    return this.vy;
  }

  /**
   * Returns horizontal velocity as a cached vec3 (y = 0).
   * Do **not** store this reference across frames.
   */
  public getHorizontalVelocity(): vec3 {
    vec3.set(this._hVel, this.vx, 0, this.vz);
    return this._hVel;
  }

  public getCurrentSpeed(): number {
    return Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  }

  /** Normal (non-boosted) max speed. */
  public getMaxSpeed(): number {
    return this._maxSpeed;
  }

  /** Scale applied to gravity each frame. 0 = zero-gravity (wall-run), < 1 = lighter. */
  public setGravityScale(scale: number): void {
    this.gravityScale = scale;
  }

  /** Whether a jump is currently in progress. */
  public isJumping(): boolean {
    return this.isJumpingFlag;
  }

  /**
   * Force-set the internal jumping flag.
   * Called by MantleSystem / VaultSystem to clear it on transition.
   */
  public setIsJumping(value: boolean): void {
    this.isJumpingFlag = value;
  }

  // ── Grounded state API ────────────────────────────────────────────────────

  /**
   * Perform a downward raycast to update the grounded state and ground normal.
   * Call once per frame (or at whatever frequency you need — enemies throttle to 20 Hz).
   * Results are available via `isGrounded()` and `getGroundNormal()`.
   */
  public updateGroundedState(capsule: CapsuleColliderComponent, snapDistance = 0.2): void {
    const hit = capsule.raycastGrounded(snapDistance);
    this._isGrounded = hit !== null;
    if (this._isGrounded && hit) {
      if (hit.normal.y > 0.1) {
        vec3.set(this._groundNormal, hit.normal.x, hit.normal.y, hit.normal.z);
        vec3.normalize(this._groundNormal, this._groundNormal);
      }
      // If normal.y <= 0.1 (steep slope), keep previous normal.
    } else {
      vec3.set(this._groundNormal, 0, 1, 0);
    }
  }

  /** Whether the character was grounded as of the last `updateGroundedState()` call. */
  public isGrounded(): boolean {
    return this._isGrounded;
  }

  /** Ground surface normal as of the last `updateGroundedState()` call. */
  public getGroundNormal(): vec3 {
    return this._groundNormal;
  }

  /**
   * Project out any velocity component pointing into `wallNormal`.
   * Call after detecting a wall collision via `numComputedCollisions()`.
   */
  public removeVelocityIntoWall(wallNormal: vec3): void {
    const dot = this.vx * wallNormal[0] + this.vz * wallNormal[2];
    if (dot < 0) {
      this.vx -= wallNormal[0] * dot;
      this.vz -= wallNormal[2] * dot;
    }
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  /**
   * Integrate velocity for one frame.
   * Uses the grounded state from the most recent `updateGroundedState()` call.
   *
   * @param dt      Delta time (seconds).
   * @param desired Desired horizontal velocity vector (direction × target speed).
   *                Pass a zero vector for no input / knockback stun.
   */
  public integrate(dt: number, desired: vec3): void {
    const isGrounded = this._isGrounded;

    // ── Coyote time ────────────────────────────────────────────────────────
    if (isGrounded) {
      this.timeSinceGrounded = 0;
      this.airJumpsUsed = 0;
      this.isJumpingFlag = false;
    } else {
      this.timeSinceGrounded += dt;
    }

    // ── Vertical: gravity ──────────────────────────────────────────────────
    if (isGrounded && this.vy < 0) {
      this.vy = -0.5; // pressed against ground
    } else if (!isGrounded) {
      const grav = this.vy > 0 ? this.ascendGravity : this.descendGravity;
      // Floaty apex: reduce gravity near the top of the jump arc when the
      // jump button is still held (isJumpingFlag = true).
      const atApex = this.isJumpingFlag && this.vy > 0 && this.vy < this.jumpCutVelocityLimit;
      const gravFactor = atApex ? this.jumpCutFactor : 1.0;
      this.vy += grav * gravFactor * this.gravityScale * dt;
    }

    // ── Horizontal ─────────────────────────────────────────────────────────
    if (this.isLegacyMode) {
      // Legacy exponential approach — preserves original enemy behaviour.
      if (isGrounded) {
        const t = 1.0 - Math.exp(-this.groundAcceleration * dt);
        this.vx += (desired[0] - this.vx) * t;
        this.vz += (desired[2] - this.vz) * t;
      } else {
        // Exponential drag first, then limited air control.
        const drag = Math.exp(-this.airDrag * dt);
        this.vx *= drag;
        this.vz *= drag;
        const t = 1.0 - Math.exp(-this.groundAcceleration * this.airControl * dt);
        this.vx += (desired[0] - this.vx) * t;
        this.vz += (desired[2] - this.vz) * t;
      }
    } else {
      // CMC linear acceleration.
      const dx = desired[0];
      const dz = desired[2];
      const desiredSpeed = Math.sqrt(dx * dx + dz * dz);
      const hasInput = desiredSpeed > 0.01;

      if (isGrounded) {
        const currentSpeed = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
        if (hasInput) {
          const newSpeed = approach(currentSpeed, desiredSpeed, this.groundAcceleration * dt);
          if (currentSpeed > desiredSpeed) {
            // Post-dash: venimos con más speed del deseado.
            // Desacelerar manteniendo la dirección actual en lugar de redirigir bruscamente.
            const scale = newSpeed / currentSpeed;
            this.vx *= scale;
            this.vz *= scale;
          } else {
            const scale = newSpeed / desiredSpeed;
            this.vx = dx * scale;
            this.vz = dz * scale;
          }
        } else {
          const newSpeed = approach(currentSpeed, 0, this.groundDeceleration * dt);
          if (currentSpeed > 0.001) {
            const scale = newSpeed / currentSpeed;
            this.vx *= scale;
            this.vz *= scale;
          } else {
            this.vx = 0;
            this.vz = 0;
          }
        }
      } else {
        // Air: vector acceleration toward desired velocity.
        // Per-axis approach causes the velocity to sweep through sideways directions
        // when one axis reaches its target before the other. Using a single capped
        // delta vector keeps the path straight in velocity space.
        const airAccel = this.groundAcceleration * this.airControl;
        if (hasInput) {
          const maxDelta = airAccel * dt;
          const ddx = dx - this.vx;
          const ddz = dz - this.vz;
          const dlen = Math.sqrt(ddx * ddx + ddz * ddz);
          if (dlen <= maxDelta) {
            this.vx = dx;
            this.vz = dz;
          } else {
            const inv = maxDelta / dlen;
            this.vx += ddx * inv;
            this.vz += ddz * inv;
          }
        } else {
          const drag = Math.pow(1.0 - this.airDrag, dt);
          this.vx *= drag;
          this.vz *= drag;
        }
      }
    }
  }

  /**
   * Apply current velocity via the KCC and write the corrected result back
   * to the rigid body's linear velocity. Automatically cancels upward velocity
   * when hitting a ceiling.
   */
  /** Velocidad interna actual (vx, vy, vz). Solo lectura. */
  public getLinearVelocity(): { x: number; y: number; z: number } {
    return { x: this.vx, y: this.vy, z: this.vz };
  }

  public applyViaKCC(
    dt: number,
    capsule: CapsuleColliderComponent,
    controller: RAPIER.KinematicCharacterController,
    ignoredCollider?: RAPIER.Collider | null,
  ): void {
    const mx = this.vx * dt;
    const my = this.vy * dt;
    const mz = this.vz * dt;

    controller.computeColliderMovement(
      capsule.getCollider(),
      new RAPIER.Vector3(mx, my, mz),
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      ignoredCollider ? (c) => c.handle !== ignoredCollider.handle : undefined,
    );

    const corrected = controller.computedMovement();
    const invDt = 1.0 / dt;
    capsule
      .getRigidBody()
      .setLinvel({ x: corrected.x * invDt, y: corrected.y * invDt, z: corrected.z * invDt }, true);

    // Cancel upward velocity if the ceiling blocked the movement.
    if (this.vy > 0 && corrected.y < my * 0.5) {
      this.vy = 0;
    }

    // Wall collision response — project out velocity into fixed-geometry walls.
    // Skips floor/ceiling normals (|n.y| >= 0.5).
    // Also pushes other kinematic bodies (KCC-driven) away from this body.
    const physics = Engine.getPhysics();
    for (let i = 0; i < controller.numComputedCollisions(); i++) {
      const collision = controller.computedCollision(i);
      if (!collision?.collider) continue;
      const rb = collision.collider.parent();
      if (!rb) continue;

      const n = collision.normal1;
      if (Math.abs(n.y) >= 0.5) continue; // skip floor/ceiling

      if (rb.bodyType() === RAPIER.RigidBodyType.Fixed) {
        this.removeVelocityIntoWall(vec3.fromValues(n.x, n.y, n.z));
        continue;
      }

      // Kinematic-kinematic: push the other body away.
      // Rapier doesn't resolve kinematic vs kinematic automatically.
      const speedIntoOther = -(this.vx * n.x + this.vz * n.z); // positive = this body moving toward other
      if (speedIntoOther < 0.3) continue;

      const entityId = physics.getEntityIdFromCollider(collision.collider.handle);
      if (entityId === undefined) continue;
      const entity = physics.getEntityById(entityId);
      if (!entity) continue;
      const otherMovement = entity.getComponent('kcc_movement') as KCCMovement | null;
      if (!otherMovement) continue;

      // Push direction = away from this body (-normal1)
      const pushX = -n.x;
      const pushZ = -n.z;

      // Only push up to what's needed to reach the desired separation speed
      const otherVel = otherMovement.getLinearVelocity();
      const enemySpeedInPushDir = otherVel.x * pushX + otherVel.z * pushZ;
      const desiredPushSpeed = Math.min(speedIntoOther, 5.0);
      const pushNeeded = desiredPushSpeed - enemySpeedInPushDir;
      if (pushNeeded > 0) {
        otherMovement.applyImpulse(vec3.fromValues(pushX * pushNeeded, 0, pushZ * pushNeeded));
      }
    }
  }
}
