import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';

export interface CameraShakeData {
  /** Default position amplitude in metres. Default 0.05 */
  positionAmplitude?: number;
  /** Default oscillation frequency in Hz. Default 8 */
  frequency?: number;
  /** Fraction of duration used to fade in [0..1]. Default 0.1 */
  blendInRatio?: number;
  /** Fraction of duration used to fade out [0..1]. Default 0.5 */
  blendOutRatio?: number;
}

export interface ShakeOverrides {
  positionAmplitude?: number;
  frequency?: number;
  blendInRatio?: number;
  blendOutRatio?: number;
}

export interface PunchOverrides {
  /** Amplitude in metres. Defaults to positionAmplitude from config. */
  amplitude?: number;
  /** Right-axis direction [-1..1]. Random unit-circle direction if omitted. */
  dirX?: number;
  /** Up-axis direction [-1..1]. Random unit-circle direction if omitted. */
  dirY?: number;
}

/**
 * CameraShakeComponent — screen-shake driven by overlapping sine waves.
 *
 * Lives on the same entity as camera_arm. Call shake() from anywhere:
 *   entity.getComponent('camera_shake').shake(0.25, { positionAmplitude: 0.08 });
 *
 * The offset is applied in arm-local right/up space by CameraArmComponent so
 * it always feels like a screen shake regardless of camera angle.
 *
 * Component key: 'camera_shake'
 */
export class CameraShakeComponent extends Component {
  // ── Defaults (from JSON config) ────────────────────────────────────────────
  private defaultAmplitude: number = 21.5;
  private defaultFrequency: number = 8;
  private defaultBlendInRatio: number = 0.1;
  private defaultBlendOutRatio: number = 0.5;

  // ── Active shake state ─────────────────────────────────────────────────────
  private active: boolean = false;
  private elapsed: number = 0;
  private totalDuration: number = 0;
  private amplitude: number = 0;
  private frequency: number = 8;
  private blendInTime: number = 0;
  private blendOutTime: number = 0;
  // Random per-shake phase so consecutive hits feel different
  private phaseX: number = 0;
  private phaseY: number = 0;

  // ── Punch state (single-arc, separate from burst shake) ───────────────────
  private punchActive: boolean = false;
  private punchElapsed: number = 0;
  private punchDuration: number = 0;
  private punchAmplitude: number = 0;
  // World-space punch direction — projected onto camera axes in CameraArmComponent.
  // null = fall back to random screen-space dirX/dirY.
  private punchWorldDir: vec3 | null = null;
  private punchDirX: number = 0;
  private punchDirY: number = 0;

  // ── Output ─────────────────────────────────────────────────────────────────
  private readonly offset: vec3 = vec3.create();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: CameraShakeData = {}): void {
    this.defaultAmplitude = data.positionAmplitude ?? 0.05;
    this.defaultFrequency = data.frequency ?? 8;
    this.defaultBlendInRatio = data.blendInRatio ?? 0.1;
    this.defaultBlendOutRatio = data.blendOutRatio ?? 0.5;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Trigger a shake.
   * If a stronger shake is already active the existing one continues (amplitude
   * is not downgraded); if the new shake is stronger it takes over immediately.
   *
   * @param duration      How long the shake lasts in seconds.
   * @param overrides     Optional per-call overrides for amplitude, frequency,
   *                      blendInRatio and blendOutRatio.
   */
  public shake(duration: number, overrides?: ShakeOverrides): void {
    const amp = overrides?.positionAmplitude ?? this.defaultAmplitude;

    if (this.active && this.amplitude >= amp) {
      // Extend duration without downgrading amplitude
      const remaining = this.totalDuration - this.elapsed;
      this.totalDuration = this.elapsed + Math.max(remaining, duration);
      return;
    }

    this.active = true;
    this.elapsed = 0;
    this.totalDuration = duration;
    this.amplitude = amp;
    this.frequency = overrides?.frequency ?? this.defaultFrequency;

    const blendIn = Math.max(0, overrides?.blendInRatio ?? this.defaultBlendInRatio);
    const blendOut = Math.max(0, overrides?.blendOutRatio ?? this.defaultBlendOutRatio);
    this.blendInTime = duration * Math.min(blendIn, 1.0 - blendOut);
    this.blendOutTime = duration * Math.min(blendOut, 1.0);

    this.phaseX = Math.random() * Math.PI * 2;
    this.phaseY = Math.random() * Math.PI * 2;
  }

  public isShaking(): boolean {
    return this.active;
  }
  /** True if either a burst shake or a single punch is in progress. */
  public isActive(): boolean {
    return this.active || this.punchActive;
  }

  /**
   * Single-arc camera punch — one smooth movement out and back.
   * Uses a half-sine envelope: starts at 0, peaks at duration/2, returns to 0.
   * Feels like a single "hit jolt" rather than a repeated shake burst.
   *
   * @param duration   Total arc time in seconds (e.g. 0.12).
   * @param overrides  Optional amplitude and direction overrides.
   */
  /**
   * @param worldDir  World-space direction of the attack (e.g. normalize(enemy - player)).
   *                  CameraArmComponent projects it onto camera right/up at apply time.
   *                  Omit for a random screen-space direction.
   */
  public punch(duration: number, worldDir?: vec3, overrides?: PunchOverrides): void {
    this.punchAmplitude = overrides?.amplitude ?? this.defaultAmplitude;
    this.punchDuration = duration;
    this.punchElapsed = 0;
    this.punchActive = true;
    this.punchWorldDir = null;
    const angle = Math.random() * Math.PI * 2;
    this.punchDirX = overrides?.dirX ?? Math.cos(angle);
    this.punchDirY = overrides?.dirY ?? Math.sin(angle);
  }

  /**
   * Returns the punch offset [right, up] projected onto the camera's local axes.
   * Call this from CameraArmComponent each frame with the camera right/up vectors.
   * Returns [0, 0] when no punch is active.
   */
  public getPunchContribution(cameraRight: vec3, cameraUp: vec3): [number, number] {
    if (!this.punchActive) return [0, 0];
    const arc = Math.sin((Math.PI * this.punchElapsed) / this.punchDuration);
    const amp = this.punchAmplitude * arc;
    if (this.punchWorldDir) {
      return [
        vec3.dot(this.punchWorldDir, cameraRight) * amp,
        vec3.dot(this.punchWorldDir, cameraUp) * amp,
      ];
    }
    return [this.punchDirX * amp, this.punchDirY * amp];
  }

  /**
   * Offset in arm-local space: X = right, Y = up (Z unused).
   * Read by CameraArmComponent after it computes finalCamPos.
   */
  public getOffset(): vec3 {
    return this.offset;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  public update(dt: number): void {
    let ox = 0;
    let oy = 0;

    // ── Burst shake ───────────────────────────────────────────────────────────
    if (this.active) {
      this.elapsed += dt;
      if (this.elapsed >= this.totalDuration) {
        this.active = false;
      } else {
        let envelope = 1.0;
        if (this.blendInTime > 0 && this.elapsed < this.blendInTime) {
          envelope = this.elapsed / this.blendInTime;
        } else if (this.blendOutTime > 0 && this.elapsed > this.totalDuration - this.blendOutTime) {
          envelope = (this.totalDuration - this.elapsed) / this.blendOutTime;
        }
        const t = this.elapsed * this.frequency * Math.PI * 2;
        ox +=
          ((Math.sin(t + this.phaseX) + 0.35 * Math.sin(t * 2.618 + this.phaseX * 1.3)) / 1.35) *
          this.amplitude *
          envelope;
        oy +=
          ((Math.cos(t + this.phaseY) + 0.35 * Math.cos(t * 1.618 + this.phaseY * 0.7)) / 1.35) *
          this.amplitude *
          envelope;
      }
    }

    // Punch arc is advanced here; contribution is computed on-demand in
    // getPunchContribution() so CameraArmComponent can project onto camera axes.
    if (this.punchActive) {
      this.punchElapsed += dt;
      if (this.punchElapsed >= this.punchDuration) this.punchActive = false;
    }

    this.offset[0] = ox;
    this.offset[1] = oy;
    this.offset[2] = 0;
  }

  public renderDebug(): void {}
}
