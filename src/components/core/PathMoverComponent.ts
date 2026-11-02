import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from './TransformComponent';

export interface PathMoverComponentData {
  /** Closed loop of local-space points, followed with a Catmull-Rom curve. */
  points: number[][];
  /** Metres per second (approximate: constant time per segment). */
  speed?: number;
  /** Vertical bob amplitude (metres) on top of the path. */
  bob?: number;
}

/** Moves its entity around a closed Catmull-Rom loop (patrolling lights, floating orbs). */
export class PathMoverComponent extends Component {
  private points: vec3[] = [];
  private segmentTimes: number[] = [];
  private loopTime = 1;
  private speed = 1.5;
  private bob = 0;
  private time = 0;
  private position = vec3.create();

  public async load(data: PathMoverComponentData): Promise<void> {
    this.points = (data.points ?? []).map((p) => vec3.fromValues(p[0]!, p[1]!, p[2]!));
    this.speed = data.speed ?? this.speed;
    this.bob = data.bob ?? 0;
    const n = this.points.length;
    this.segmentTimes = this.points.map((p, i) => vec3.distance(p, this.points[(i + 1) % n]!) / this.speed);
    this.loopTime = this.segmentTimes.reduce((a, b) => a + b, 0) || 1;
  }

  public update(dt: number): void {
    const n = this.points.length;
    if (n < 2) return;
    this.time = (this.time + dt) % this.loopTime;

    let t = this.time;
    let seg = 0;
    while (seg < n - 1 && t > this.segmentTimes[seg]!) {
      t -= this.segmentTimes[seg]!;
      seg++;
    }
    const u = Math.min(1, t / Math.max(this.segmentTimes[seg]!, 1e-4));
    const p0 = this.points[(seg - 1 + n) % n]!;
    const p1 = this.points[seg]!;
    const p2 = this.points[(seg + 1) % n]!;
    const p3 = this.points[(seg + 2) % n]!;
    const u2 = u * u;
    const u3 = u2 * u;
    for (let k = 0; k < 3; k++) {
      this.position[k] =
        0.5 *
        (2 * p1[k]! +
          (-p0[k]! + p2[k]!) * u +
          (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * u2 +
          (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * u3);
    }
    this.position[1]! += Math.sin(this.time * 2.1) * this.bob;

    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    transform?.getTransform().setLocalPosition(this.position);
  }
}
