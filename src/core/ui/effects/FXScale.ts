// src/core/ui/effects/FXScale.ts
import { vec2 } from 'gl-matrix';
import { WidgetEffect } from '../WidgetEffect';
import { InterpolatorFactory } from '../../math/Interpolators';
import type { Interpolator } from '../../../types/Interpolator.interface';
import { EffectMode } from '../../../types/WidgetTypes';

/**
 * FXScale - Animates widget scale over time with interpolation.
 * Replicates C++ CFXScale.
 *
 * Supports three modes: Single, Loop, PingPong.
 */
export class FXScale extends WidgetEffect {
  private scale: vec2 = vec2.fromValues(1, 1);
  private initialScale: vec2 = vec2.fromValues(1, 1);
  private duration: number = 0;
  private mode: EffectMode = EffectMode.SINGLE;
  private interpolator: Interpolator;
  private time: number = 0;

  constructor(
    name: string,
    targetScale: vec2,
    duration: number,
    mode: EffectMode = EffectMode.SINGLE,
    interpolatorType: string = 'linear',
  ) {
    super(name);

    vec2.copy(this.scale, targetScale);
    this.duration = duration;
    this.mode = mode;
    this.interpolator = InterpolatorFactory.get(interpolatorType);
  }

  public start(): void {
    if (!this.owner) return;

    // Store initial scale from owner
    const ownerScale = this.owner.getScale();
    vec2.set(this.initialScale, ownerScale[0], ownerScale[1]);
  }

  public stop(): void {
    if (!this.owner) return;

    // Restore initial scale
    this.owner.setScale(this.initialScale[0], this.initialScale[1]);
    this.owner.updateTransform();
  }

  public update(dt: number): void {
    if (!this.owner || this.duration <= 0) return;

    this.time += dt;

    let finalScale = vec2.create();

    switch (this.mode) {
      case EffectMode.SINGLE: {
        if (this.time < this.duration) {
          const ratio = this.time / this.duration;
          const interpolated = this.interpolate(ratio);
          vec2.lerp(finalScale, this.initialScale, this.scale, interpolated);
        } else {
          vec2.copy(finalScale, this.scale);
        }
        break;
      }

      case EffectMode.LOOP: {
        const ratio = (this.time % this.duration) / this.duration;
        const interpolated = this.interpolate(ratio);
        vec2.lerp(finalScale, this.initialScale, this.scale, interpolated);
        break;
      }

      case EffectMode.PING_PONG: {
        const direction = Math.floor(this.time / this.duration) % 2;
        const ratio = (this.time % this.duration) / this.duration;
        const interpolated = this.interpolate(ratio);

        if (direction === 0) {
          // Forward: initial → scale
          vec2.lerp(finalScale, this.initialScale, this.scale, interpolated);
        } else {
          // Backward: scale → initial
          vec2.lerp(finalScale, this.scale, this.initialScale, interpolated);
        }
        break;
      }
    }

    // Apply scale to owner
    this.owner.setScale(finalScale[0], finalScale[1]);
    this.owner.updateTransform();
  }

  // ============================================================================
  // INTERPOLATION
  // ============================================================================

  private interpolate(ratio: number): number {
    return this.interpolator.blend(0, 1, ratio);
  }

  // ============================================================================
  // CONFIGURATION METHODS
  // ============================================================================

  /**
   * Change target scale.
   */
  public setScale(x: number, y: number): void {
    vec2.set(this.scale, x, y);
  }

  /**
   * Set initial scale.
   */
  public setInitialScale(x: number, y: number): void {
    vec2.set(this.initialScale, x, y);
  }

  /**
   * Change duration.
   */
  public changeDuration(duration: number): void {
    this.duration = duration;
  }

  /**
   * Set current time (for seeking).
   */
  public setTime(time: number): void {
    this.time = time;
  }

  /**
   * Get current time.
   */
  public getTime(): number {
    return this.time;
  }

  /**
   * Reset effect to start.
   */
  public reset(): void {
    this.time = 0;
  }

  /**
   * Set effect mode.
   */
  public setMode(mode: EffectMode): void {
    this.mode = mode;
  }

  /**
   * Get effect mode.
   */
  public getMode(): EffectMode {
    return this.mode;
  }

  /**
   * Set interpolator by type name.
   */
  public setInterpolator(interpolatorType: string): void {
    this.interpolator = InterpolatorFactory.get(interpolatorType);
  }

  /**
   * Check if effect is complete (for Single mode).
   */
  public isComplete(): boolean {
    return this.mode === EffectMode.SINGLE && this.time >= this.duration;
  }
}
