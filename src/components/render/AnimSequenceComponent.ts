import { quat, vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { AnimatorComponent } from './AnimatorComponent';

export interface AnimSequenceStep {
  clip: string;
  /** Clip time at which the next step starts (cancel point). Default: the clip's end. */
  next?: number;
  /** Clip time this step starts at (a chained attack's entry pose). Default 0. */
  from?: number;
  /** Crossfade into this step. Default 0.08 s. */
  blend?: number;
}

export interface AnimSequenceData {
  steps: AnimSequenceStep[];
  /** Move this entity by the clips' root motion. Default true. */
  rootMotion?: boolean;
  /** Seconds to wait after the last step before starting again (looping). Default 0.6. */
  pause?: number;
  /** Return to the starting position when the sequence starts again. Default true. */
  resetPosition?: boolean;
}

/**
 * AnimSequenceComponent — plays a chain of clips on the sibling animator, each one cancelled into
 * the next at its `next` time, and moves the entity with the extracted root motion. Loops.
 * Used to review attack combos (dev `?animLoop=Spear_Combo`).
 *
 * Runs after 'animator' (components.json): the root-motion delta it applies belongs to the pose
 * the animator just evaluated, and it refreshes the transform itself since 'transform' already ran.
 *
 * Component key: 'anim_sequence'
 */
export class AnimSequenceComponent extends Component {
  private steps: AnimSequenceStep[] = [];
  private rootMotion = true;
  private pause = 0.6;
  private resetPosition = true;

  private animator: AnimatorComponent | null = null;
  private stepIndex = -1;
  private waiting = 0;
  private readonly startPos = vec3.create();
  private readonly _delta = vec3.create();
  private readonly _invParentRot = quat.create();

  public load(data: AnimSequenceData): void {
    this.steps = data.steps ?? [];
    this.rootMotion = data.rootMotion ?? true;
    this.pause = data.pause ?? 0.6;
    this.resetPosition = data.resetPosition ?? true;
  }

  public override async onAttach(): Promise<void> {
    this.animator = this.getOwner().getComponent('animator') as AnimatorComponent | null;
    const tc = this.getTransform();
    if (tc) vec3.copy(this.startPos, tc.getTransform().getLocalPosition());
    if (this.animator && this.rootMotion) this.animator.setRootMotion('extract');
  }

  public update(dt: number): void {
    const animator = this.animator;
    if (!animator || this.steps.length === 0) return;

    if (this.rootMotion) this.applyRootMotion(animator);

    if (this.stepIndex < 0) {
      this.waiting -= dt;
      if (this.waiting > 0) return;
      this.start(0);
      return;
    }
    const step = this.steps[this.stepIndex]!;
    const end = step.next ?? animator.getClipDuration(step.clip);
    if (animator.getPlaybackTime() < end) return;
    if (this.stepIndex + 1 < this.steps.length) {
      this.start(this.stepIndex + 1);
    } else if (animator.getPlaybackTime() >= animator.getClipDuration(step.clip)) {
      // Sequence over: hold the last frame, then start again
      this.stepIndex = -1;
      this.waiting = this.pause;
    }
  }

  private start(index: number): void {
    const step = this.steps[index]!;
    if (index === 0 && this.resetPosition) {
      const tc = this.getTransform();
      tc?.getTransform().setLocalPosition(this.startPos);
      tc?.update();
    }
    this.stepIndex = index;
    this.animator!.playClip(step.clip, {
      blendTime: index === 0 ? 0.15 : (step.blend ?? 0.08),
      startTime: step.from ?? 0,
    });
  }

  private applyRootMotion(animator: AnimatorComponent): void {
    const delta = animator.getRootMotionDelta();
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return;
    const tc = this.getTransform();
    if (!tc) return;
    // The delta is in world space; the entity moves in its parent's space.
    const parentTc = this.getOwner().getParent()?.getComponent('transform') as
      | TransformComponent
      | null
      | undefined;
    vec3.copy(this._delta, delta);
    if (parentTc) {
      quat.invert(this._invParentRot, parentTc.getTransform().getWorldRotation());
      vec3.transformQuat(this._delta, this._delta, this._invParentRot);
    }
    const t = tc.getTransform();
    t.setLocalPosition(vec3.add(this._delta, t.getLocalPosition(), this._delta));
    tc.update();
  }

  private getTransform(): TransformComponent | null {
    return this.getOwner().getComponent('transform') as TransformComponent | null;
  }

  public override renderDebug(): void {}
}
