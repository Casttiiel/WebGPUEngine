import { vec3, quat } from 'gl-matrix';

export interface ProceduralPose {
  posOffset: vec3;
  rotOffset: quat;
}

export interface ProceduralViewModelConfig {
  /** Sway: how strongly mouse movement tilts/shifts the weapon (default 0.04) */
  swayAmount?: number;
  /** Sway lerp speed (default 8.0 — higher = snappier return) */
  swaySpeed?: number;

  /** Bob: horizontal amplitude in metres (default 0.005) */
  bobAmplitudeX?: number;
  /** Bob: vertical amplitude in metres (default 0.007) */
  bobAmplitudeY?: number;
  /** Bob: frequency in Hz (default 1.8) */
  bobFrequency?: number;
  /** Speed threshold (m/s) below which bobbing stops (default 0.1) */
  bobSpeedThreshold?: number;

  /** Breathing idle: amplitude in metres (default 0.002) */
  breatheAmplitude?: number;
  /** Breathing frequency in Hz (default 0.25) */
  breatheFrequency?: number;

  /** Landing impact: how much a hard landing squashes the weapon (default 0.06) */
  landingImpactAmount?: number;
  /** Landing spring frequency (default 12.0) */
  landingSpringFreq?: number;
  /** Landing spring damping ratio (default 0.7) */
  landingSpringDamp?: number;

  /** Recoil: initial push-back on fire in metres (default 0.05) */
  recoilAmount?: number;
  /** Recoil spring frequency (default 20.0) */
  recoilSpringFreq?: number;
  /** Recoil spring damping ratio (default 0.8) */
  recoilSpringDamp?: number;
}

/**
 * ProceduralViewModelSystem
 *
 * Centralises all procedural first-person weapon motion:
 *   • WeaponSway  — tilts weapon opposite to mouse movement
 *   • WeaponBob   — sinusoidal bob when moving
 *   • BreathingIdle — subtle sine breathing when still
 *   • LandingImpact — spring-damper squash on landing
 *   • Recoil       — spring-damper kick on fire
 *
 * Call update(dt, ...) every frame; call triggerRecoil() / triggerLanding() on events.
 * The result is accumulated into a single ProceduralPose { posOffset, rotOffset }.
 */
export class ProceduralViewModelSystem {
  // ── Sway ─────────────────────────────────────────────────────────────────
  private swayAmount: number = 0.04;
  private swaySpeed: number = 8.0;
  private swayX: number = 0;
  private swayY: number = 0;

  // ── Bob ──────────────────────────────────────────────────────────────────
  private bobAmpX: number = 0.005;
  private bobAmpY: number = 0.007;
  private bobFreq: number = 1.8;
  private bobSpeedThreshold: number = 0.1;
  private bobTime: number = 0;

  // ── Breathing ────────────────────────────────────────────────────────────
  private breatheAmp: number = 0.002;
  private breatheFreq: number = 0.25;
  private breatheTime: number = 0;

  // ── Landing impact ───────────────────────────────────────────────────────
  private landingImpactAmount: number = 0.06;
  private landingSpringFreq: number = 12.0;
  private landingSpringDamp: number = 0.7;
  private landingDisp: number = 0;
  private landingVel: number = 0;

  // ── Recoil ───────────────────────────────────────────────────────────────
  private recoilAmount: number = 0.05;
  private recoilSpringFreq: number = 20.0;
  private recoilSpringDamp: number = 0.8;
  private recoilDisp: number = 0;
  private recoilVel: number = 0;

  // ── Output pose (reused to avoid allocations) ────────────────────────────
  private readonly pose: ProceduralPose = {
    posOffset: vec3.create(),
    rotOffset: quat.create(),
  };

  constructor(config?: ProceduralViewModelConfig) {
    if (config) this.configure(config);
  }

  public configure(config: ProceduralViewModelConfig): void {
    if (config.swayAmount !== undefined) this.swayAmount = config.swayAmount;
    if (config.swaySpeed !== undefined) this.swaySpeed = config.swaySpeed;
    if (config.bobAmplitudeX !== undefined) this.bobAmpX = config.bobAmplitudeX;
    if (config.bobAmplitudeY !== undefined) this.bobAmpY = config.bobAmplitudeY;
    if (config.bobFrequency !== undefined) this.bobFreq = config.bobFrequency;
    if (config.bobSpeedThreshold !== undefined) this.bobSpeedThreshold = config.bobSpeedThreshold;
    if (config.breatheAmplitude !== undefined) this.breatheAmp = config.breatheAmplitude;
    if (config.breatheFrequency !== undefined) this.breatheFreq = config.breatheFrequency;
    if (config.landingImpactAmount !== undefined)
      this.landingImpactAmount = config.landingImpactAmount;
    if (config.landingSpringFreq !== undefined) this.landingSpringFreq = config.landingSpringFreq;
    if (config.landingSpringDamp !== undefined) this.landingSpringDamp = config.landingSpringDamp;
    if (config.recoilAmount !== undefined) this.recoilAmount = config.recoilAmount;
    if (config.recoilSpringFreq !== undefined) this.recoilSpringFreq = config.recoilSpringFreq;
    if (config.recoilSpringDamp !== undefined) this.recoilSpringDamp = config.recoilSpringDamp;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** Call when the player fires to trigger recoil spring. */
  public triggerRecoil(): void {
    this.recoilVel -= this.recoilAmount * this.recoilSpringFreq * 2;
  }

  /** Call when the player lands after a fall. `intensity` ∈ [0,1]. */
  public triggerLanding(intensity: number = 1.0): void {
    this.landingVel -= this.landingImpactAmount * intensity * this.landingSpringFreq * 2;
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  /**
   * Update and return the accumulated procedural pose.
   * @param dt          delta time in seconds
   * @param mouseDeltaX raw mouse X delta this frame (pixels or radians)
   * @param mouseDeltaY raw mouse Y delta this frame (pixels or radians)
   * @param moveSpeed   current character speed (m/s), 0 when standing still
   */
  public update(
    dt: number,
    mouseDeltaX: number,
    mouseDeltaY: number,
    moveSpeed: number,
  ): Readonly<ProceduralPose> {
    const bobPos = this.updateBob(dt, moveSpeed);
    const breathePos = this.updateBreathing(dt, moveSpeed);
    const landY = this.updateSpring('landing', dt);
    const recoilZ = this.updateSpring('recoil', dt);

    // Sway only contributes rotation — no positional shift so the weapon stays
    // at its socket position when looking around.
    this.updateSway(dt, mouseDeltaX, mouseDeltaY);

    // Accumulate position offsets (bob + breathing + springs only)
    vec3.set(
      this.pose.posOffset,
      bobPos[0] + breathePos[0],
      bobPos[1] + breathePos[1] + landY,
      recoilZ,
    );

    // Rotation from sway: tilt X-axis by -swayX (pitch), tilt Y-axis by swayY (yaw)
    const pitchRad = -this.swayX * 0.5;
    const yawRad = this.swayY * 0.5;
    const swayQuat = quat.fromEuler(
      quat.create(),
      pitchRad * (180 / Math.PI),
      yawRad * (180 / Math.PI),
      0,
    );
    quat.copy(this.pose.rotOffset, swayQuat);

    return this.pose;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private readonly _swayResult: vec3 = vec3.create();

  private updateSway(dt: number, dx: number, dy: number): vec3 {
    const targetX = -dy * this.swayAmount;
    const targetY = -dx * this.swayAmount;
    const alpha = 1.0 - Math.exp(-this.swaySpeed * dt);
    this.swayX += (targetX - this.swayX) * alpha;
    this.swayY += (targetY - this.swayY) * alpha;
    vec3.set(this._swayResult, this.swayY, this.swayX, 0);
    return this._swayResult;
  }

  private readonly _bobResult: vec3 = vec3.create();

  private updateBob(dt: number, speed: number): vec3 {
    if (speed > this.bobSpeedThreshold) {
      this.bobTime += dt;
    } else {
      // Smoothly return bob cycle to zero when stopping
      this.bobTime += dt * 0.3;
    }
    const intensity = speed > this.bobSpeedThreshold ? 1.0 : 0.0;
    const bx = Math.sin(this.bobTime * this.bobFreq * Math.PI * 2) * this.bobAmpX * intensity;
    const by = Math.abs(Math.sin(this.bobTime * this.bobFreq * Math.PI)) * this.bobAmpY * intensity;
    vec3.set(this._bobResult, bx, -by, 0);
    return this._bobResult;
  }

  private readonly _breatheResult: vec3 = vec3.create();

  private updateBreathing(dt: number, speed: number): vec3 {
    this.breatheTime += dt;
    // Fade out breathing when moving
    const breatheIntensity = Math.max(0, 1.0 - speed / (this.bobSpeedThreshold + 0.5));
    const bx =
      Math.sin(this.breatheTime * this.breatheFreq * Math.PI * 2) *
      this.breatheAmp *
      breatheIntensity;
    const by =
      Math.cos(this.breatheTime * this.breatheFreq * Math.PI) *
      this.breatheAmp *
      0.5 *
      breatheIntensity;
    vec3.set(this._breatheResult, bx, by, 0);
    return this._breatheResult;
  }

  /** Simple implicit-Euler spring-damper. Returns the current displacement. */
  private updateSpring(type: 'landing' | 'recoil', dt: number): number {
    const freq = type === 'landing' ? this.landingSpringFreq : this.recoilSpringFreq;
    const damp = type === 'landing' ? this.landingSpringDamp : this.recoilSpringDamp;

    if (type === 'landing') {
      const omega = freq * 2 * Math.PI;
      const acc = -(omega * omega * this.landingDisp + 2 * damp * omega * this.landingVel);
      this.landingVel += acc * dt;
      this.landingDisp += this.landingVel * dt;
      return this.landingDisp;
    } else {
      const omega = freq * 2 * Math.PI;
      const acc = -(omega * omega * this.recoilDisp + 2 * damp * omega * this.recoilVel);
      this.recoilVel += acc * dt;
      this.recoilDisp += this.recoilVel * dt;
      return this.recoilDisp;
    }
  }
}
