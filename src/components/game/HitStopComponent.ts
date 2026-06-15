import { Component } from '../../core/ecs/Component';
import { AnimatorComponent } from '../render/AnimatorComponent';

/**
 * HitStopComponent — freezes this entity's animation and movement for a brief
 * duration when a melee hit connects, giving impacts a sense of weight.
 *
 * - Pauses AnimatorComponent (self or first child) so the pose holds.
 * - Exposes isFrozen() so movement controllers can skip their update.
 *
 * Usage: call freeze(seconds) from PlayerAttackComponent when damage is dealt.
 * Component key: 'hit_stop'
 */
export class HitStopComponent extends Component {
  private timer: number = 0;
  private delayTimer: number = 0;
  private pendingFreeze: number = 0;
  private animator: AnimatorComponent | null = null;
  private animResolved: boolean = false;

  public load(): void {}

  /**
   * Freeze this entity for `seconds` real-world seconds.
   * `delay` lets the hit-reaction animation start blending in before the pause.
   * Default delay is 2 frames (2/60 ≈ 33 ms).
   */
  public freeze(seconds: number, delay: number = 2 / 60): void {
    if (delay > 0) {
      this.pendingFreeze = Math.max(this.pendingFreeze, seconds);
      this.delayTimer = Math.max(this.delayTimer, delay);
    } else {
      this.applyFreeze(seconds);
    }
  }

  public isFrozen(): boolean {
    return this.timer > 0;
  }

  public update(dt: number): void {
    // Countdown before applying the freeze so hit-reaction has time to register
    if (this.delayTimer > 0) {
      this.delayTimer -= dt;
      if (this.delayTimer <= 0) {
        this.delayTimer = 0;
        const pending = this.pendingFreeze;
        this.pendingFreeze = 0;
        if (pending > 0) this.applyFreeze(pending);
      }
    }

    if (this.timer <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0;
      this.findAnimator()?.setPaused(false);
    }
  }

  private applyFreeze(seconds: number): void {
    const wasAlreadyFrozen = this.timer > 0;
    this.timer = Math.max(this.timer, seconds);
    if (!wasAlreadyFrozen) {
      this.findAnimator()?.setPaused(true);
    }
  }

  private findAnimator(): AnimatorComponent | null {
    if (this.animResolved) return this.animator;
    this.animResolved = true;
    const self = this.getOwner().getComponent('animator') as AnimatorComponent | null;
    if (self) { this.animator = self; return self; }
    for (const child of this.getOwner().getChildren()) {
      const c = child.getComponent('animator') as AnimatorComponent | null;
      if (c) { this.animator = c; return c; }
    }
    return null;
  }

  public renderDebug(): void {}
}
