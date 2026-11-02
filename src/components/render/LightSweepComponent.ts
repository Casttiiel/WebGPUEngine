import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { SpotLightComponent } from './SpotLightComponent';

export interface LightSweepComponentData {
  /** Points the spot aims at in turn (world space); it eases back and forth along them. */
  targets: number[][];
  /** Seconds for a full sweep from the first target to the last and back. */
  period?: number;
}

/** Sweeps the spot light on the same entity between world-space targets (searchlight). */
export class LightSweepComponent extends Component {
  private targets: vec3[] = [];
  private period = 8;
  private time = 0;
  private aim = vec3.create();

  public async load(data: LightSweepComponentData): Promise<void> {
    this.targets = (data.targets ?? []).map((t) => vec3.fromValues(t[0]!, t[1]!, t[2]!));
    this.period = data.period ?? this.period;
  }

  public update(dt: number): void {
    const spot = this.getOwner().getComponent('spot_light') as SpotLightComponent | null;
    if (!spot || this.targets.length < 2) return;
    this.time += dt;

    // Ping-pong 0..1..0 with eased ends, mapped across the target polyline.
    const phase = (this.time / this.period) % 1;
    const s = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const x = s * (this.targets.length - 1);
    const i = Math.min(Math.floor(x), this.targets.length - 2);
    vec3.lerp(this.aim, this.targets[i]!, this.targets[i + 1]!, x - i);

    const camera = spot.getCamera();
    camera.lookAt(camera.getPosition(), this.aim);
    camera.updateUniforms(0);
    // Re-uploads the light uniforms and AABB from the new orientation.
    spot.setFov((camera.getFov() * 180) / Math.PI);
  }
}
