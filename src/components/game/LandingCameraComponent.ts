import { Component } from '../../core/ecs/Component';
import { BasePlayerController } from './BasePlayerController';

export interface LandingCameraComponentData {
  /**
   * Maximum downward dip in metres on a max-speed landing (default: 0.10).
   * The offset is purely additive — it never displaces the character's actual position.
   */
  maxDipAmplitude?: number;
  /** Fall speed (m/s) that maps to full maxDipAmplitude (default: 12.0) */
  maxImpactSpeed?: number;
  /** Minimum fall speed (m/s) before any effect is triggered (default: 2.0) */
  minImpactSpeed?: number;
  /**
   * Spring stiffness for Y dip recovery (default: 200).
   * Higher = faster snap-back. Lower = slower, heavier feel.
   */
  dipStiffness?: number;
  /**
   * Spring damping for Y dip (default: 18).
   * Values well below 2*sqrt(dipStiffness) ≈ 28 keep one clean bounce.
   */
  dipDamping?: number;
  /** Maximum pitch tilt in degrees on a max-speed landing (default: 3.0) */
  maxPitchPunch?: number;
  /** Spring stiffness for pitch return (default: 120) */
  pitchStiffness?: number;
  /** Spring damping for pitch return (default: 18) */
  pitchDamping?: number;
  enabled?: boolean;
}

/**
 * LandingCameraComponent
 *
 * Purely additive landing effects — never offsets cameraY from ownerY during
 * normal movement, so the character mesh is never visible.
 *
 * Effects triggered only on the airborne → grounded edge:
 *
 *  1. Y DIP  – spring offset that punches the camera down then bounces back.
 *              Proportional to fall speed. The spring target is always 0, so
 *              the camera returns exactly to eye level with one clean bounce.
 *
 *  2. PITCH PUNCH – brief forward tilt (look-down), separate spring to 0.
 *
 * API consumed by FPSCameraControllerComponent:
 *   getLandingYOffset()     → metres to add to eyePos.y  (≤ 0 during dip, small + on bounce)
 *   getLandingPitchOffset() → degrees to add to pitch    (> 0 = look-down punch)
 */
export class LandingCameraComponent extends Component {
  // ── Config ──────────────────────────────────────────────────────────
  private maxDipAmplitude: number = 0.1;
  private maxImpactSpeed: number = 12.0;
  private minImpactSpeed: number = 2.0;
  private dipStiffness: number = 200;
  private dipDamping: number = 18;
  private maxPitchPunch: number = 3.0;
  private pitchStiffness: number = 120;
  private pitchDamping: number = 18;
  public override enabled: boolean = true;

  // ── Y dip spring  (offset toward 0) ─────────────────────────────────
  private yOffset: number = 0; // metres added to eyePos.y
  private yVelocity: number = 0;

  // ── Pitch spring (offset toward 0) ──────────────────────────────────
  private pitchOffset: number = 0; // degrees
  private pitchVelocity: number = 0;

  // ── Landing detection ────────────────────────────────────────────────
  private wasGrounded: boolean = true;
  private lastVerticalVelocity: number = 0;

  constructor() {
    super();
  }

  public async load(data: LandingCameraComponentData): Promise<void> {
    if (data.maxDipAmplitude !== undefined) this.maxDipAmplitude = data.maxDipAmplitude;
    if (data.maxImpactSpeed !== undefined) this.maxImpactSpeed = data.maxImpactSpeed;
    if (data.minImpactSpeed !== undefined) this.minImpactSpeed = data.minImpactSpeed;
    if (data.dipStiffness !== undefined) this.dipStiffness = data.dipStiffness;
    if (data.dipDamping !== undefined) this.dipDamping = data.dipDamping;
    if (data.maxPitchPunch !== undefined) this.maxPitchPunch = data.maxPitchPunch;
    if (data.pitchStiffness !== undefined) this.pitchStiffness = data.pitchStiffness;
    if (data.pitchDamping !== undefined) this.pitchDamping = data.pitchDamping;
    if (data.enabled !== undefined) this.enabled = data.enabled;
  }

  public update(dt: number): void {
    if (!this.enabled) return;

    // ── Landing detection ────────────────────────────────────────────
    const charCtrl = this.getOwner().getComponent(
      'player_controller',
    ) as BasePlayerController | null;

    if (charCtrl) {
      const isGrounded = charCtrl.getIsGrounded();
      const vertVel = charCtrl.getVerticalVelocity();

      // airborne → grounded edge
      if (!this.wasGrounded && isGrounded) {
        const impactSpeed = Math.abs(Math.min(this.lastVerticalVelocity, 0));

        if (impactSpeed > this.minImpactSpeed) {
          const t = Math.min(
            (impactSpeed - this.minImpactSpeed) / (this.maxImpactSpeed - this.minImpactSpeed),
            1.0,
          );
          const s = t * t * (3 - 2 * t); // smoothstep

          // Kick Y downward — spring restores to 0 → natural dip + single bounce
          this.yVelocity = -this.maxDipAmplitude * s * this.dipStiffness * 0.35;

          // Kick pitch forward (look-down punch)
          this.pitchVelocity = this.maxPitchPunch * s * (this.pitchStiffness * 0.06);
        }
      }

      this.wasGrounded = isGrounded;
      if (!isGrounded) {
        this.lastVerticalVelocity = vertVel;
      }
    }

    // ── Y dip spring  →  target 0 ────────────────────────────────────
    //   a = -k * x - d * v
    this.yVelocity += (-this.dipStiffness * this.yOffset - this.dipDamping * this.yVelocity) * dt;
    this.yOffset += this.yVelocity * dt;

    // Clamp: allow a small upward bounce but never large enough to clip mesh
    this.yOffset = Math.max(
      -this.maxDipAmplitude * 1.5,
      Math.min(this.maxDipAmplitude * 0.4, this.yOffset),
    );

    // ── Pitch spring  →  target 0 ─────────────────────────────────────
    this.pitchVelocity +=
      (-this.pitchStiffness * this.pitchOffset - this.pitchDamping * this.pitchVelocity) * dt;
    this.pitchOffset += this.pitchVelocity * dt;
    this.pitchOffset = Math.max(
      -this.maxPitchPunch * 0.3,
      Math.min(this.maxPitchPunch * 1.5, this.pitchOffset),
    );
  }

  /** Metres to add to eyePos.y.  Negative during dip, small positive on bounce. */
  public getLandingYOffset(): number {
    return this.yOffset;
  }

  /** Degrees to add to camera pitch.  Positive = look-down punch. */
  public getLandingPitchOffset(): number {
    return this.pitchOffset;
  }

  public override renderInMenu(): void {}
  public renderDebug(): void {}
  public override dispose(): void {}
}
