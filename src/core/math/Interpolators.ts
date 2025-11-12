import { Interpolator } from '../../types/Interpolator.interface';

// Linear interpolation
export class LinearInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    return start + (end - start) * ratio;
  }
}

// Cubic interpolation (smoothstep)
export class SmoothStepInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    const t2 = ratio * ratio * (3 - 2 * ratio);
    return start + (end - start) * t2;
  }
}

// Ease-in interpolation
export class EaseInInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    const t2 = ratio * ratio;
    return start + (end - start) * t2;
  }
}

// Ease-out interpolation
export class EaseOutInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    const t2 = 1 - (1 - ratio) * (1 - ratio);
    return start + (end - start) * t2;
  }
}

// Sine interpolation
export class SineInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    const t2 = Math.sin(ratio * Math.PI * 0.5);
    return start + (end - start) * t2;
  }
}

// Exponential interpolation
export class ExponentialInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    const t2 = ratio === 0 ? 0 : Math.pow(2, 10 * (ratio - 1));
    return start + (end - start) * t2;
  }
}
