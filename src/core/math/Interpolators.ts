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

// ============================================================================
// UI SYSTEM INTERPOLATORS (from C++/DirectX11 original)
// ============================================================================

/**
 * Quad In-Out interpolation (ease in and out)
 * Used by UI effects for smooth animations
 */
export class QuadInOutInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    let t = ratio * 2;
    let t2: number;

    if (t < 1) {
      t2 = 0.5 * t * t; // Ease in (first half)
    } else {
      t -= 1;
      t2 = -0.5 * (t * (t - 2) - 1); // Ease out (second half)
    }

    return start + (end - start) * t2;
  }
}

/**
 * Back Out interpolation (overshoots then settles)
 * Creates a "bounce back" effect at the end
 */
export class BackOutInterpolator implements Interpolator {
  private readonly s = 1.70158; // Overshoot amount

  blend(start: number, end: number, ratio: number): number {
    const t = ratio - 1;
    const t2 = t * t * ((this.s + 1) * t + this.s) + 1;
    return start + (end - start) * t2;
  }
}

/**
 * Bounce Out interpolation (bouncing ball effect)
 * Creates multiple bounces that decrease in amplitude
 */
export class BounceOutInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    let t2: number;

    if (ratio < 1 / 2.75) {
      t2 = 7.5625 * ratio * ratio;
    } else if (ratio < 2 / 2.75) {
      const t = ratio - 1.5 / 2.75;
      t2 = 7.5625 * t * t + 0.75;
    } else if (ratio < 2.5 / 2.75) {
      const t = ratio - 2.25 / 2.75;
      t2 = 7.5625 * t * t + 0.9375;
    } else {
      const t = ratio - 2.625 / 2.75;
      t2 = 7.5625 * t * t + 0.984375;
    }

    return start + (end - start) * t2;
  }
}

/**
 * Elastic Out interpolation (spring effect)
 * Creates an elastic/spring-like motion
 */
export class ElasticOutInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    if (ratio === 0 || ratio === 1) return start + (end - start) * ratio;

    const p = 0.3;
    const s = p / 4;
    const t2 = Math.pow(2, -10 * ratio) * Math.sin(((ratio - s) * (2 * Math.PI)) / p) + 1;

    return start + (end - start) * t2;
  }
}

// ============================================================================
// INTERPOLATOR FACTORY (Singleton Pattern for UI System)
// ============================================================================

/**
 * InterpolatorFactory - Provides static singleton instances of interpolators.
 *
 * ⚠️ IMPORTANT: Interpolators are SINGLETONS, not dynamically created.
 * This matches the C++/DirectX11 original architecture where interpolators
 * are referenced, not instantiated per effect.
 */
export class InterpolatorFactory {
  // Singleton instances (created once, reused everywhere)
  private static readonly linear = new LinearInterpolator();
  private static readonly smoothStep = new SmoothStepInterpolator();
  private static readonly easeIn = new EaseInInterpolator();
  private static readonly easeOut = new EaseOutInterpolator();
  private static readonly sine = new SineInterpolator();
  private static readonly exponential = new ExponentialInterpolator();

  // UI-specific interpolators
  private static readonly quadInOut = new QuadInOutInterpolator();
  private static readonly backOut = new BackOutInterpolator();
  private static readonly bounceOut = new BounceOutInterpolator();
  private static readonly elasticOut = new ElasticOutInterpolator();

  /**
   * Get interpolator by name (used by UI parser)
   * @param type - Interpolator type name
   * @returns Singleton interpolator instance
   */
  public static get(type: string): Interpolator {
    switch (type.toLowerCase()) {
      case 'linear':
        return this.linear;
      case 'smoothstep':
      case 'smooth':
        return this.smoothStep;
      case 'easein':
      case 'ease-in':
        return this.easeIn;
      case 'easeout':
      case 'ease-out':
        return this.easeOut;
      case 'sine':
        return this.sine;
      case 'exponential':
      case 'expo':
        return this.exponential;
      case 'quad':
      case 'quadinout':
      case 'quad-in-out':
        return this.quadInOut;
      case 'back':
      case 'backout':
      case 'back-out':
        return this.backOut;
      case 'bounce':
      case 'bounceout':
      case 'bounce-out':
        return this.bounceOut;
      case 'elastic':
      case 'elasticout':
      case 'elastic-out':
        return this.elasticOut;
      default:
        console.warn(`Unknown interpolator type: ${type}, using linear`);
        return this.linear;
    }
  }

  // Direct getters for type-safe access
  public static getLinear(): Interpolator {
    return this.linear;
  }
  public static getSmoothStep(): Interpolator {
    return this.smoothStep;
  }
  public static getEaseIn(): Interpolator {
    return this.easeIn;
  }
  public static getEaseOut(): Interpolator {
    return this.easeOut;
  }
  public static getSine(): Interpolator {
    return this.sine;
  }
  public static getExponential(): Interpolator {
    return this.exponential;
  }
  public static getQuadInOut(): Interpolator {
    return this.quadInOut;
  }
  public static getBackOut(): Interpolator {
    return this.backOut;
  }
  public static getBounceOut(): Interpolator {
    return this.bounceOut;
  }
  public static getElasticOut(): Interpolator {
    return this.elasticOut;
  }
}
