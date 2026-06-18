import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { IMsg, TMsgOnDamaged } from '../../core/ecs/Msg';
import { AnimatorComponent } from '../render/AnimatorComponent';
import { TransformComponent } from '../core/TransformComponent';
import type { KCCMovement } from './movement/KCCMovement';

export interface RecoveryClipEntry {
  /** Clip name in the animator. */
  clip: string;
  /**
   * Representative character-local velocity this clip was authored for (m/s).
   * Convention: [right, 0, forward] where forward = getFront() direction.
   * Examples:
   *   [0, 0, -5]  — knocked backward  (most common: attacker in front)
   *   [0, 0,  5]  — knocked forward   (attacker from behind)
   *   [ 5, 0, 0]  — knocked rightward
   *   [-5, 0, 0]  — knocked leftward
   */
  velocity: [number, number, number];
}

export interface MotionMatchRecoveryData {
  clips?:        RecoveryClipEntry[];
  /** Minimum horizontal knockback speed (m/s) to trigger a recovery clip. Default: 2.5. */
  minKnockSpeed?: number;
  /**
   * Seconds to wait after the hit before sampling velocity.
   * Lets the impulse take effect before we read KCCMovement. Default: 0.08.
   */
  matchDelay?:   number;
  /** Blend layer weight. Default: 0.85. */
  weight?:       number;
  /** Blend-in time in seconds. Default: 0.08. */
  blendIn?:      number;
  /** Minimum seconds between recoveries. Default: 0.5. */
  cooldown?:     number;
  /**
   * Minimum dot-product score to accept a match (−1 to 1).
   * Avoids playing a clip that faces the wrong direction. Default: 0.3.
   */
  minMatchScore?: number;
}

/**
 * MotionMatchRecoveryComponent — Velocity-driven recovery clip selection.
 *
 * After receiving damage with significant knockback, waits a short delay
 * (matchDelay) then reads the character's actual world-space velocity from
 * KCCMovement, projects it into character-local space, and picks the recovery
 * clip whose authored velocity best matches the current movement direction.
 *
 * This is a simplified Motion Matching query: instead of selecting from
 * an animation state machine, we search a small database and find the best fit.
 */
export class MotionMatchRecoveryComponent extends Component {
  private clips:         RecoveryClipEntry[] = [];
  private minKnockSpeed: number = 2.5;
  private matchDelay:    number = 0.08;
  private weight:        number = 0.85;
  private blendIn:       number = 0.08;
  private cooldown:      number = 0.5;
  private minMatchScore: number = 0.3;

  private cooldownTimer: number = 0;
  private matchTimer:    number = 0;
  private matchPending:  boolean = false;

  private animator:      AnimatorComponent | null = null;
  private movement:      KCCMovement | null = null;
  private resolved:      boolean = false;

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DAMAGED, 'motion_match_recovery', (comp, msg) => {
      (comp as MotionMatchRecoveryComponent).onDamaged(msg as IMsg<TMsgOnDamaged>);
    });
  }

  public load(data: MotionMatchRecoveryData): void {
    this.clips         = data?.clips         ?? this.clips;
    this.minKnockSpeed = data?.minKnockSpeed ?? this.minKnockSpeed;
    this.matchDelay    = data?.matchDelay    ?? this.matchDelay;
    this.weight        = data?.weight        ?? this.weight;
    this.blendIn       = data?.blendIn       ?? this.blendIn;
    this.cooldown      = data?.cooldown      ?? this.cooldown;
    this.minMatchScore = data?.minMatchScore ?? this.minMatchScore;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.resolve();

    if (this.matchPending) {
      this.matchTimer -= dt;
      if (this.matchTimer <= 0) {
        this.matchPending = false;
        this.performMatch();
      }
    }
  }

  private onDamaged(_msg: IMsg<TMsgOnDamaged>): void {
    if (this.cooldownTimer > 0) return;
    if (this.clips.length === 0) return;

    // Schedule the match after matchDelay so the KCC impulse has taken effect
    this.matchPending = true;
    this.matchTimer   = this.matchDelay;
  }

  private performMatch(): void {
    if (!this.movement || !this.animator) return;

    const worldVel = this.movement.getHorizontalVelocity();
    const speed    = vec3.length(worldVel);
    if (speed < this.minKnockSpeed) return;

    // Project world-space velocity into character-local space
    const ownerTc = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!ownerTc) return;

    const t       = ownerTc.getTransform();
    const localX  = vec3.dot(worldVel, t.getRight());   // rightward component
    const localZ  = vec3.dot(worldVel, t.getFront());   // forward component
    const localVel = vec3.fromValues(localX, 0, localZ);
    const localDir = vec3.normalize(vec3.create(), localVel);

    // Search: find the clip whose authored velocity direction matches best
    let bestClip:  string | null = null;
    let bestScore: number = -Infinity;

    for (const entry of this.clips) {
      if (!this.animator.hasClip(entry.clip)) continue;

      const entryVel = vec3.fromValues(entry.velocity[0], 0, entry.velocity[2]);
      const entryLen = vec3.length(entryVel);
      if (entryLen < 0.001) continue;

      const entryDir = vec3.normalize(vec3.create(), entryVel);
      const score    = vec3.dot(localDir, entryDir);  // [-1, 1]

      if (score > bestScore) {
        bestScore = score;
        bestClip  = entry.clip;
      }
    }

    if (bestClip !== null && bestScore >= this.minMatchScore) {
      this.animator.addLayer(bestClip, {
        loop: false,
        weight: this.weight,
        blendInTime: this.blendIn,
      });
      this.cooldownTimer = this.cooldown;
    }
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;

    const owner = this.getOwner();
    this.movement = owner.getComponent('kcc_movement') as KCCMovement | null;

    // Animator might be on a child (same pattern as HitReactionComponent)
    const selfAnim = owner.getComponent('animator') as AnimatorComponent | null;
    if (selfAnim) {
      this.animator = selfAnim;
      return;
    }
    for (const child of owner.getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) { this.animator = anim; return; }
    }
  }

  public renderDebug(): void {}
}
