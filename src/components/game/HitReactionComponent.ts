import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { IMsg, TMsgOnDamaged } from '../../core/ecs/Msg';
import { AnimatorComponent } from '../render/AnimatorComponent';
import { TransformComponent } from '../core/TransformComponent';
import { HitStopComponent } from './HitStopComponent';

// ── Bone warp configuration ───────────────────────────────────────────────────

export interface WarpBoneConfig {
  name: string;
  /** Fraction of the total impulse this bone receives [0,1]. */
  share: number;
  /**
   * Spring stiffness — higher = faster snap toward 0.
   * Cascade defaults: spine_01=80, spine_02=50, spine_03=30, head=15.
   */
  springK: number;
  /**
   * Velocity multiplier applied per second [0,1].
   * Use ζ = -ln(dampFactor) / (2 × √springK) to reason about the damping ratio.
   * ζ ≈ 0.40 → ~4% overshoot (spine). ζ ≈ 0.50 → ~16% overshoot (head).
   */
  dampFactor: number;
}

interface WarpBoneState {
  cfg: WarpBoneConfig;
  curPitch: number; // current additive pitch (degrees)
  curRoll: number; // current additive roll (degrees)
  velPitch: number; // degrees/s
  velRoll: number; // degrees/s
}

// Default 4-bone cascade.
// springK high → fast snap (spine_01 peaks at ~140ms, head at ~310ms).
// dampFactor = exp(-0.8 × √springK) → ζ ≈ 0.40 for all bones: ~4% overshoot,
// clean single arc without visible oscillation.
const DEFAULT_WARP_BONES: WarpBoneConfig[] = [
  { name: 'spine_01', share: 0.50, springK: 80, dampFactor: 0.001 },  // ζ ≈ 0.40
  { name: 'spine_02', share: 0.30, springK: 50, dampFactor: 0.004 },  // ζ ≈ 0.40
  { name: 'spine_03', share: 0.20, springK: 30, dampFactor: 0.013 },  // ζ ≈ 0.40
  { name: 'head',     share: 0.15, springK: 15, dampFactor: 0.045 },  // ζ ≈ 0.40
];

// ── Data interface ─────────────────────────────────────────────────────────────

export interface HitReactionData {
  cooldown?: number;
  /** Max warp angle injected at impact (degrees). Default: 25. */
  warpAngleDeg?: number;
  /** Custom bone chain. Omit to use the default 4-bone cascade. */
  warpBones?: WarpBoneConfig[];
  /** Noise amplitude multiplier. Scales with current impulse magnitude. Default: 0.02. */
  noiseFactor?: number;
}

/**
 * HitReactionComponent — Spring-damped directional hit warp.
 *
 * Architecture (3 separate layers, no mixing):
 *   Layer 1 — Animation clip  : addLayer() on the animator
 *   Layer 2 — Additive warp   : setAdditiveRotation() on the bone chain
 *   Layer 3 — IK              : untouched, runs independently
 *
 * On impact, a single velocity impulse is injected into each bone's spring.
 * The spring target is ALWAYS 0 (rest), so the motion is a single cohesive
 * arc: snap away → spring pulls back. No two-phase conflict.
 *
 * Each bone has its own stiffness / damping:
 *   spine_01 — fast, overdamped: clean single snap
 *   spine_02 — slight lag, small overshoot
 *   spine_03 — more lag, secondary motion
 *   head     — underdamped: clear head bob after impact
 *
 * Noise is injected into VELOCITY (not position) so it modulates speed
 * without reversing direction on any bone.
 */
export class HitReactionComponent extends Component {
  private cooldown: number = 0.3;
  private warpAngleDeg: number = 25;
  private noiseFactor: number = 0.02;
  /** Multiplies all bones' springK at runtime — higher = snappier recovery, lower = longer tail. */
  private springScale: number = 1.0;

  private cooldownTimer: number = 0;
  private time: number = 0;
  private impulseMag: number = 0;

  private bones: WarpBoneState[] = [];
  private animator: AnimatorComponent | null = null;
  private animatorFound: boolean = false;
  private hitStop: HitStopComponent | null = null;
  private hitStopFound: boolean = false;

  // ── Registration ─────────────────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DAMAGED, 'hit_reaction', (comp, msg) => {
      (comp as HitReactionComponent).onDamaged(msg as IMsg<TMsgOnDamaged>);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  public load(data: HitReactionData): void {
    this.cooldown     = data?.cooldown     ?? this.cooldown;
    this.warpAngleDeg = data?.warpAngleDeg ?? this.warpAngleDeg;
    this.noiseFactor  = data?.noiseFactor  ?? this.noiseFactor;

    const cfgs = data?.warpBones ?? DEFAULT_WARP_BONES;
    this.bones = cfgs.map((cfg) => ({
      cfg,
      curPitch: 0,
      curRoll: 0,
      velPitch: 0,
      velRoll: 0,
    }));
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    this.findAnimator();
    this.findHitStop();
    if (this.hitStop?.isFrozen()) return;
    this.time += dt;
    this.tickWarp(dt);
  }

  // ── Hit handler ───────────────────────────────────────────────────────────────

  private onDamaged(msg: IMsg<TMsgOnDamaged>): void {
    if (this.cooldownTimer > 0) return;
    this.findAnimator();
    if (!this.animator) return;
    this.injectImpulse(msg.payload.instigator);
    this.cooldownTimer = this.cooldown;
  }

  /** Debug: fire warp from a given direction without needing a real hit. */
  private fireTest(rightDot: number, forwardDot: number): void {
    this.findAnimator();
    if (!this.animator) return;
    const ip = forwardDot * this.warpAngleDeg;
    const ir = rightDot * this.warpAngleDeg;
    this.impulseMag = Math.sqrt(ip * ip + ir * ir);
    this.applyImpulseToChain(ip, ir);
    this.cooldownTimer = 0;
  }

  private injectImpulse(instigator: import('../../core/ecs/Entity').Entity | null): void {
    const { rightDot, forwardDot } = this.computeHitDots(instigator);
    const ip = forwardDot * this.warpAngleDeg;
    const ir = rightDot * this.warpAngleDeg;
    this.impulseMag = Math.sqrt(ip * ip + ir * ir);
    this.applyImpulseToChain(ip, ir);
  }

  private applyImpulseToChain(impulsePitch: number, impulseRoll: number): void {
    for (const s of this.bones) {
      // kickScale ≈ sqrt(springK): normalization so peak ≈ warpAngleDeg × share.
      // ×2.0 compensates for amplitude loss due to ζ≈0.40 damping (~41% loss vs ideal).
      const kickScale = Math.sqrt(s.cfg.springK * this.springScale) * 2.0;
      s.velPitch += impulsePitch * s.cfg.share * kickScale;
      s.velRoll  += impulseRoll  * s.cfg.share * kickScale;
    }
  }

  // ── Per-frame spring integration ──────────────────────────────────────────────

  private tickWarp(dt: number): void {
    if (!this.animator) return;

    this.impulseMag *= Math.exp(-5.0 * dt);

    let anyActive = false;

    for (let i = 0; i < this.bones.length; i++) {
      const s = this.bones[i]!;

      // Spring restoring force toward 0
      const effectiveK = s.cfg.springK * this.springScale;
      s.velPitch += -s.curPitch * effectiveK * dt;
      s.velRoll  += -s.curRoll  * effectiveK * dt;

      // Small decorative noise — never large enough to override direction
      if (this.noiseFactor > 0.001 && this.impulseMag > 0.5) {
        const n = Math.sin(this.time * 23.7 + i * 0.9) * this.impulseMag * this.noiseFactor;
        s.velPitch += n;
        s.velRoll  += n * 0.7;
      }

      // Frame-rate independent exponential damping
      const damp = Math.pow(s.cfg.dampFactor, dt);
      s.velPitch *= damp;
      s.velRoll  *= damp;

      // Integrate
      s.curPitch += s.velPitch * dt;
      s.curRoll  += s.velRoll  * dt;

      if (Math.abs(s.curPitch) > 0.01 || Math.abs(s.curRoll) > 0.01
       || Math.abs(s.velPitch) > 0.1  || Math.abs(s.velRoll)  > 0.1) {
        this.animator.setAdditiveRotation(s.cfg.name, s.curPitch, s.curRoll);
        anyActive = true;
      } else {
        s.curPitch = 0; s.curRoll = 0;
        s.velPitch = 0; s.velRoll = 0;
        this.animator.clearAdditiveRotation(s.cfg.name);
      }
    }

    if (!anyActive) this.impulseMag = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private computeHitDots(instigator: import('../../core/ecs/Entity').Entity | null): {
    rightDot: number;
    forwardDot: number;
  } {
    if (!instigator) return { rightDot: 0, forwardDot: 1 };

    const myTc = this.getOwner().getComponent('transform') as TransformComponent | null;
    const attackerTc = instigator.getComponent('transform') as TransformComponent | null;
    if (!myTc || !attackerTc) return { rightDot: 0, forwardDot: 1 };

    const toAttacker = vec3.normalize(
      vec3.create(),
      vec3.subtract(
        vec3.create(),
        attackerTc.getTransform().getWorldPosition() as vec3,
        myTc.getTransform().getWorldPosition() as vec3,
      ),
    );

    return {
      rightDot: vec3.dot(toAttacker, myTc.getTransform().getRight()),
      forwardDot: vec3.dot(toAttacker, myTc.getTransform().getFront()),
    };
  }

  private findHitStop(): void {
    if (this.hitStopFound) return;
    this.hitStopFound = true;
    this.hitStop = this.getOwner().getComponent('hit_stop') as HitStopComponent | null;
  }

  private findAnimator(): void {
    if (this.animatorFound) return;
    const self = this.getOwner().getComponent('animator') as AnimatorComponent | null;
    if (self) {
      this.animator = self;
      this.animatorFound = true;
      return;
    }
    for (const child of this.getOwner().getChildren()) {
      const anim = child.getComponent('animator') as AnimatorComponent | null;
      if (anim) {
        this.animator = anim;
        break;
      }
    }
    this.animatorFound = true;
  }

  public renderDebug(): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (!parentFolder || this._editorFolder) return;

    const f = parentFolder.addFolder('Hit Reaction');
    f.close();

    // ── Global params ──────────────────────────────────────────────────────
    f.add(this, 'warpAngleDeg', 0, 60, 0.5).name('Warp Angle (deg)');
    f.add(this, 'noiseFactor', 0, 0.2, 0.005).name('Noise Factor');
    f.add(this, 'cooldown', 0.0, 2.0, 0.05).name('Cooldown (s)');
    f.add(this, 'springScale', 0.1, 5.0, 0.05).name('Recovery Speed ×');

    // ── Test fire buttons ──────────────────────────────────────────────────
    const fire = {
      front: () => this.fireTest(0, 1),
      back: () => this.fireTest(0, -1),
      right: () => this.fireTest(1, 0),
      left: () => this.fireTest(-1, 0),
    };
    const fb = f.addFolder('Test Fire');
    fb.open();
    fb.add(fire, 'front').name('↑  Fire Front');
    fb.add(fire, 'back').name('↓  Fire Back');
    fb.add(fire, 'right').name('→  Fire Right');
    fb.add(fire, 'left').name('←  Fire Left');

    // ── Per-bone cascade ───────────────────────────────────────────────────
    const bb = f.addFolder('Bone Cascade');
    bb.open();
    for (const s of this.bones) {
      const bf = bb.addFolder(s.cfg.name);
      bf.add(s.cfg, 'share', 0.0, 1.0, 0.05).name('Share');
      bf.add(s.cfg, 'springK', 1, 150, 1).name('Spring K');
      bf.add(s.cfg, 'dampFactor', 0.0, 1.0, 0.01).name('Damp Factor');
    }

    this._editorFolder = f;
  }
}
