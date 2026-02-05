// src/core/ui/effects/FXRotate.ts
import { WidgetEffect } from '../WidgetEffect';
import { InterpolatorFactory } from '../../math/Interpolators';
import type { Interpolator } from '../../../types/Interpolator.interface';
import { EffectMode } from '../../../types/WidgetTypes';

/**
 * FXRotate - Animates widget rotation over time with interpolation.
 * Optional effect for rotating UI elements.
 */
export class FXRotate extends WidgetEffect {
  private targetRotation: number = 0;
  private initialRotation: number = 0;
  private duration: number = 0;
  private mode: EffectMode = EffectMode.SINGLE;
  private interpolator: Interpolator;
  private time: number = 0;

  constructor(
    name: string,
    targetRotation: number,
    duration: number,
    mode: EffectMode = EffectMode.SINGLE,
    interpolatorType: string = 'linear',
  ) {
    super(name);

    this.targetRotation = targetRotation;
    this.duration = duration;
    this.mode = mode;
    this.interpolator = InterpolatorFactory.get(interpolatorType);
  }

  public override start(): void {
    if (!this.owner) return;
    this.initialRotation = this.owner.getRotation();
  }

  public override stop(): void {
    if (!this.owner) return;
    this.owner.setRotation(this.initialRotation);
    this.owner.updateTransform();
  }

  public update(dt: number): void {
    if (!this.owner || this.duration <= 0) return;

    this.time += dt;
    let finalRotation = 0;

    switch (this.mode) {
      case EffectMode.SINGLE: {
        if (this.time < this.duration) {
          const ratio = this.time / this.duration;
          finalRotation = this.interpolator.blend(this.initialRotation, this.targetRotation, ratio);
        } else {
          finalRotation = this.targetRotation;
        }
        break;
      }

      case EffectMode.LOOP: {
        const ratio = (this.time % this.duration) / this.duration;
        finalRotation = this.interpolator.blend(this.initialRotation, this.targetRotation, ratio);
        break;
      }

      case EffectMode.PING_PONG: {
        const direction = Math.floor(this.time / this.duration) % 2;
        const ratio = (this.time % this.duration) / this.duration;

        if (direction === 0) {
          finalRotation = this.interpolator.blend(this.initialRotation, this.targetRotation, ratio);
        } else {
          finalRotation = this.interpolator.blend(this.targetRotation, this.initialRotation, ratio);
        }
        break;
      }
    }

    this.owner.setRotation(finalRotation);
    this.owner.updateTransform();
  }

  public setTargetRotation(rotation: number): void {
    this.targetRotation = rotation;
  }

  public override changeDuration(duration: number): void {
    this.duration = duration;
  }

  public override setTime(time: number): void {
    this.time = time;
  }

  public reset(): void {
    this.time = 0;
  }
}
