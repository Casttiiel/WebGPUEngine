import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { CameraComponent } from './CameraComponent';

export interface CameraBookmarksComponentData {
  /** Saved views, recalled with the number keys 1…9 in order. */
  views: { position: number[]; target: number[] }[];
}

const DIGITS = [
  KeyCode.NUM_1,
  KeyCode.NUM_2,
  KeyCode.NUM_3,
  KeyCode.NUM_4,
  KeyCode.NUM_5,
  KeyCode.NUM_6,
  KeyCode.NUM_7,
  KeyCode.NUM_8,
  KeyCode.NUM_9,
];

/**
 * Number keys jump the camera on the same entity to saved views, so lighting can be compared
 * (e.g. GI off / realtime / compare) from exactly the same framing.
 */
export class CameraBookmarksComponent extends Component {
  private views: { position: vec3; target: vec3 }[] = [];

  public async load(data: CameraBookmarksComponentData): Promise<void> {
    this.views = (data.views ?? []).map((v) => ({
      position: vec3.fromValues(v.position[0]!, v.position[1]!, v.position[2]!),
      target: vec3.fromValues(v.target[0]!, v.target[1]!, v.target[2]!),
    }));
  }

  public update(_dt: number): void {
    const input = Engine.getInput();
    for (let i = 0; i < this.views.length && i < DIGITS.length; i++) {
      if (input.isKeyJustPressed(DIGITS[i]!)) this.goTo(i);
    }
  }

  public goTo(index: number): void {
    const view = this.views[index];
    const camera = this.getOwner().getComponent('camera') as CameraComponent | null;
    if (!view || !camera) return;
    camera.getCamera().lookAt(view.position, view.target);
  }
}
