import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';

export interface GIVolumeComponentData {
  /** Box size in metres (world axes), centred on the entity. */
  size: number[];
  /** Metres between probes (default 0.5). */
  spacing?: number;
}

/**
 * A local realtime-GI probe volume (src/renderer/gi): a fine probe grid over an interior —
 * house, cave, corridor — so its lighting doesn't come from the coarse camera cascades of an
 * open world. Sampled before the level volume / cascades; only traced while the camera is near.
 * Axis-aligned: the entity's rotation is ignored.
 */
export class GIVolumeComponent extends Component {
  private size = vec3.fromValues(8, 4, 8);
  private spacing = 0.5;

  public async load(data: GIVolumeComponentData): Promise<void> {
    if (data.size) vec3.set(this.size, data.size[0]!, data.size[1]!, data.size[2]!);
    this.spacing = data.spacing ?? this.spacing;
  }

  public update(_dt: number): void {}

  /** World-space box (min, max) and probe spacing. */
  public getBox(): { min: vec3; max: vec3; spacing: number } {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    const center = transform ? transform.getTransform().getWorldPosition() : vec3.create();
    const half = vec3.scale(vec3.create(), this.size, 0.5);
    return {
      min: vec3.sub(vec3.create(), center, half),
      max: vec3.add(vec3.create(), center, half),
      spacing: this.spacing,
    };
  }
}
