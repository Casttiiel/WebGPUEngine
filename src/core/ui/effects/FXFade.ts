// src/core/ui/effects/FXFade.ts
import { WidgetEffect } from '../WidgetEffect';
import { InterpolatorFactory } from '../../math/Interpolators';
import type { Interpolator } from '../../../types/Interpolator.interface';
import { EffectMode } from '../../../types/WidgetTypes';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';

/**
 * FXFade - Animates widget alpha/opacity over time.
 * Optional effect for fade-in/fade-out transitions.
 */
export class FXFade extends WidgetEffect {
  private targetAlpha: number = 1;
  private initialAlpha: number = 1;
  private duration: number = 0;
  private mode: EffectMode = EffectMode.SINGLE;
  private interpolator: Interpolator;
  private time: number = 0;

  constructor(
    name: string,
    targetAlpha: number,
    duration: number,
    mode: EffectMode = EffectMode.SINGLE,
    interpolatorType: string = 'linear',
  ) {
    super(name);

    this.targetAlpha = Math.max(0, Math.min(1, targetAlpha));
    this.duration = duration;
    this.mode = mode;
    this.interpolator = InterpolatorFactory.get(interpolatorType);
  }

  public start(): void {
    if (!this.owner) return;

    // Store initial alpha from image color
    if (this.owner instanceof ImageWidget) {
      const imageWidget = this.owner as ImageWidget;
      this.initialAlpha = imageWidget.getColor().a;
    }
  }

  public stop(): void {
    if (!this.owner || !(this.owner instanceof ImageWidget)) return;

    // Restore initial alpha
    const imageWidget = this.owner as ImageWidget;
    const color = imageWidget.getColor();
    imageWidget.setColor(color.r, color.g, color.b, this.initialAlpha);
  }

  public update(dt: number): void {
    if (!this.owner || this.duration <= 0) return;
    if (!(this.owner instanceof ImageWidget)) return;

    this.time += dt;
    let finalAlpha = 1;

    switch (this.mode) {
      case EffectMode.SINGLE: {
        if (this.time < this.duration) {
          const ratio = this.time / this.duration;
          finalAlpha = this.interpolator.blend(this.initialAlpha, this.targetAlpha, ratio);
        } else {
          finalAlpha = this.targetAlpha;
        }
        break;
      }

      case EffectMode.LOOP: {
        const ratio = (this.time % this.duration) / this.duration;
        finalAlpha = this.interpolator.blend(this.initialAlpha, this.targetAlpha, ratio);
        break;
      }

      case EffectMode.PING_PONG: {
        const direction = Math.floor(this.time / this.duration) % 2;
        const ratio = (this.time % this.duration) / this.duration;

        if (direction === 0) {
          finalAlpha = this.interpolator.blend(this.initialAlpha, this.targetAlpha, ratio);
        } else {
          finalAlpha = this.interpolator.blend(this.targetAlpha, this.initialAlpha, ratio);
        }
        break;
      }
    }

    // Apply alpha to owner
    const imageWidget = this.owner as ImageWidget;
    const color = imageWidget.getColor();
    imageWidget.setColor(color.r, color.g, color.b, finalAlpha);
  }

  public setTargetAlpha(alpha: number): void {
    this.targetAlpha = Math.max(0, Math.min(1, alpha));
  }

  public changeDuration(duration: number): void {
    this.duration = duration;
  }

  public setTime(time: number): void {
    this.time = time;
  }

  public reset(): void {
    this.time = 0;
  }

  public isComplete(): boolean {
    return this.mode === EffectMode.SINGLE && this.time >= this.duration;
  }
}
