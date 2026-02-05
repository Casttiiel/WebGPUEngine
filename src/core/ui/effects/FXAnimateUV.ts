// src/core/ui/effects/FXAnimateUV.ts
import { vec2 } from 'gl-matrix';
import { WidgetEffect } from '../WidgetEffect';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';

/**
 * FXAnimateUV - Animates UV coordinates over time.
 * Used for scrolling textures, water effects, fire, etc.
 */
export class FXAnimateUV extends WidgetEffect {
  private speed: vec2 = vec2.fromValues(0, 0);

  constructor(name: string, speedU: number = 0, speedV: number = 0) {
    super(name);
    this.speed = vec2.fromValues(speedU, speedV);
  }

  public update(dt: number): void {
    if (!this.owner) return;

    // Only works with ImageWidget or subclasses
    if (!(this.owner instanceof ImageWidget)) {
      console.warn(`FXAnimateUV "${this.name}" requires ImageWidget owner`);
      return;
    }

    const imageWidget = this.owner as ImageWidget;
    const imageParams = imageWidget.getImageParams();

    // Accumulate UV offset based on speed and delta time
    const offsetU = this.speed[0] * dt;
    const offsetV = this.speed[1] * dt;

    // Update minUV and maxUV
    const minUV = imageParams.minUV;
    const maxUV = imageParams.maxUV;

    imageWidget.setMinUV(minUV.x + offsetU, minUV.y + offsetV);
    imageWidget.setMaxUV(maxUV.x + offsetU, maxUV.y + offsetV);
  }

  // ============================================================================
  // CONFIGURATION METHODS
  // ============================================================================

  /**
   * Stop UV animation immediately.
   */
  public override stopUiFx(): void {
    vec2.set(this.speed, 0, 0);
  }

  /**
   * Change UV scroll speed.
   */
  public override changeSpeedUV(x: number, y: number): void {
    vec2.set(this.speed, x, y);
  }

  /**
   * Set speed vector directly.
   */
  public setSpeed(speed: vec2): void {
    vec2.copy(this.speed, speed);
  }

  /**
   * Get current speed.
   */
  public getSpeed(): vec2 {
    return this.speed;
  }

  /**
   * Set min UV directly on owner.
   */
  public override setMinUV(u: number, v: number): void {
    if (this.owner && this.owner instanceof ImageWidget) {
      (this.owner as ImageWidget).setMinUV(u, v);
    }
  }

  /**
   * Set max UV directly on owner.
   */
  public override setMaxUV(u: number, v: number): void {
    if (this.owner && this.owner instanceof ImageWidget) {
      (this.owner as ImageWidget).setMaxUV(u, v);
    }
  }
}
