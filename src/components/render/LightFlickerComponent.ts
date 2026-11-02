import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { PointLightComponent } from './PointLightComponent';
import { SpotLightComponent } from './SpotLightComponent';

export interface LightFlickerComponentData {
  /** Intensity swing as a fraction of the base intensity (0 = steady, 0.5 = ±50 %). */
  amount?: number;
  /** Flicker rate (≈ crackles per second). */
  speed?: number;
  /** Random position wobble around the start position (metres). */
  jitter?: number;
  /** Colour at the dimmest point, blended toward the light's own colour as it brightens. */
  dimColor?: number[];
}

/**
 * Fire-like flicker for the point or spot light on the same entity: two noise octaves (a slow
 * "breath" and a fast crackle) drive intensity, colour shifts toward `dimColor` as it dims, and
 * the light wobbles a few centimetres so shadows and bounce light move like a flame.
 */
export class LightFlickerComponent extends Component {
  private amount = 0.35;
  private speed = 8;
  private jitter = 0.03;
  private dimColor: number[] | null = null;

  private time = Math.random() * 100;
  private seed = Math.random() * 1000;
  private light: PointLightComponent | SpotLightComponent | null = null;
  private baseIntensity = 0;
  private baseColor = [1, 1, 1];
  private basePosition = vec3.create();
  private scratch = vec3.create();

  public async load(data: LightFlickerComponentData): Promise<void> {
    this.amount = data.amount ?? this.amount;
    this.speed = data.speed ?? this.speed;
    this.jitter = data.jitter ?? this.jitter;
    this.dimColor = data.dimColor ?? null;
  }

  public update(dt: number): void {
    if (!this.light && !this.bind()) return;
    this.time += dt;
    const t = this.time * this.speed;

    // 0..1 flame "energy": slow breathing + fast crackle, sharpened so dips are short.
    const slow = this.noise(t * 0.25, 0);
    const fast = this.noise(t, 17);
    const energy = Math.min(1, Math.max(0, 0.6 * slow + 0.4 * fast));
    const k = 1 - this.amount + 2 * this.amount * energy * energy;
    const light = this.light!;
    light.setIntensity(this.baseIntensity * k);

    if (this.dimColor) {
      const c = this.baseColor;
      const d = this.dimColor;
      const w = Math.min(1, energy * 1.4);
      light.setColor(
        d[0]! + (c[0]! - d[0]!) * w,
        d[1]! + (c[1]! - d[1]!) * w,
        d[2]! + (c[2]! - d[2]!) * w,
      );
    }

    if (this.jitter > 0 && light instanceof PointLightComponent) {
      const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
      if (transform) {
        vec3.set(
          this.scratch,
          this.basePosition[0]! + (this.noise(t * 0.7, 31) - 0.5) * 2 * this.jitter,
          this.basePosition[1]! + (this.noise(t * 0.7, 47) - 0.5) * 2 * this.jitter,
          this.basePosition[2]! + (this.noise(t * 0.7, 59) - 0.5) * 2 * this.jitter,
        );
        transform.getTransform().setLocalPosition(this.scratch);
      }
    }
  }

  private bind(): boolean {
    const owner = this.getOwner();
    const light =
      (owner.getComponent('point_light') as PointLightComponent | null) ??
      (owner.getComponent('spot_light') as SpotLightComponent | null);
    if (!light) return false;
    this.light = light;
    this.baseIntensity = light.getIntensity();
    const c = light.getColor();
    this.baseColor = [c[0]!, c[1]!, c[2]!];
    const transform = owner.getComponent('transform') as TransformComponent | null;
    if (transform) vec3.copy(this.basePosition, transform.getTransform().getLocalPosition());
    return true;
  }

  /** Smooth 1D value noise in [0, 1]. */
  private noise(x: number, channel: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return this.hash(i + channel * 101) * (1 - u) + this.hash(i + 1 + channel * 101) * u;
  }

  private hash(n: number): number {
    const s = Math.sin((n + this.seed) * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }
}
