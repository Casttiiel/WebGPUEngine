import { vec3, quat } from 'gl-matrix';
import { ViewModelAnimationData, ViewModelClip } from '../../types/ViewModelAnimation.type';

export interface ViewModelPose {
  position: vec3;
  rotation: quat;
  scale: vec3;
}

interface InternalClip {
  data: ViewModelClip;
  duration: number;
}

/**
 * ViewModelAnimator — plays keyframe animation clips for first-person view-model slots.
 *
 * Supports:
 *  • Multiple named clips (idle, attack, throw, equip, block, …)
 *  • Crossfade blending between two clips
 *  • Loop / one-shot playback
 *  • Callback on clip end (for state-machine transitions)
 */
export class ViewModelAnimator {
  private clips: Map<string, InternalClip> = new Map();
  private activeClip: InternalClip | null = null;
  private activeTime: number = 0;

  /** Clip that is being faded out */
  private fromClip: InternalClip | null = null;
  private fromTime: number = 0;
  private crossfadeElapsed: number = 0;
  private crossfadeDuration: number = 0;

  /** Fired when a one-shot clip finishes */
  public onClipEnd: ((clipName: string) => void) | null = null;

  /** Scratch pose objects (avoid allocations in hot path) */
  private readonly poseA: ViewModelPose = {
    position: vec3.create(),
    rotation: quat.create(),
    scale: vec3.fromValues(1, 1, 1),
  };
  private readonly poseB: ViewModelPose = {
    position: vec3.create(),
    rotation: quat.create(),
    scale: vec3.fromValues(1, 1, 1),
  };
  private readonly result: ViewModelPose = {
    position: vec3.create(),
    rotation: quat.create(),
    scale: vec3.fromValues(1, 1, 1),
  };

  // ── Public API ────────────────────────────────────────────────────────────

  /** Load animation data from a parsed JSON asset */
  public loadData(data: ViewModelAnimationData): void {
    this.clips.clear();
    for (const clip of data.clips) {
      const sorted = [...clip.keyframes].sort((a, b) => a.time - b.time);
      const duration = clip.duration ?? (sorted.length > 0 ? sorted[sorted.length - 1]!.time : 0);
      this.clips.set(clip.name, { data: { ...clip, keyframes: sorted }, duration });
    }
  }

  /** Play a clip by name. `blendTime` fades from the current clip over that many seconds. */
  public play(name: string, blendTime: number = 0): void {
    const clip = this.clips.get(name);
    if (!clip) {
      console.warn(`ViewModelAnimator: clip '${name}' not found`);
      return;
    }
    if (this.activeClip === clip) return; // already playing

    if (blendTime > 0 && this.activeClip) {
      this.fromClip = this.activeClip;
      this.fromTime = this.activeTime;
      this.crossfadeElapsed = 0;
      this.crossfadeDuration = blendTime;
    } else {
      this.fromClip = null;
    }

    this.activeClip = clip;
    this.activeTime = 0;
  }

  /** Update animation state; returns the current interpolated pose. */
  public update(dt: number): Readonly<ViewModelPose> {
    if (!this.activeClip) {
      this.resetPose(this.result);
      return this.result;
    }

    // Advance active clip
    this.activeTime += dt;
    const loop = this.activeClip.data.loop ?? true;
    if (this.activeTime > this.activeClip.duration) {
      if (loop) {
        this.activeTime %= this.activeClip.duration;
      } else {
        this.activeTime = this.activeClip.duration;
        const name = this.activeClip.data.name;
        this.fromClip = null;
        this.onClipEnd?.(name);
      }
    }

    this.sampleClip(this.activeClip, this.activeTime, this.poseA);

    // Crossfade from previous clip
    if (this.fromClip && this.crossfadeDuration > 0) {
      this.fromTime += dt;
      this.crossfadeElapsed += dt;
      const t = Math.min(this.crossfadeElapsed / this.crossfadeDuration, 1.0);

      if (t >= 1.0) {
        this.fromClip = null;
      } else {
        this.sampleClip(this.fromClip, this.fromTime, this.poseB);
        // Blend: result = lerp(poseB[from], poseA[to], t)
        vec3.lerp(this.result.position, this.poseB.position, this.poseA.position, t);
        quat.slerp(this.result.rotation, this.poseB.rotation, this.poseA.rotation, t);
        vec3.lerp(this.result.scale, this.poseB.scale, this.poseA.scale, t);
        return this.result;
      }
    }

    // No crossfade — copy poseA directly
    vec3.copy(this.result.position, this.poseA.position);
    quat.copy(this.result.rotation, this.poseA.rotation);
    vec3.copy(this.result.scale, this.poseA.scale);
    return this.result;
  }

  public hasClip(name: string): boolean {
    return this.clips.has(name);
  }

  public getActiveClipName(): string | null {
    return this.activeClip?.data.name ?? null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private sampleClip(clip: InternalClip, time: number, out: ViewModelPose): void {
    const kfs = clip.data.keyframes;
    if (kfs.length === 0) {
      this.resetPose(out);
      return;
    }
    if (kfs.length === 1) {
      const kf = kfs[0]!;
      vec3.set(out.position, kf.position[0], kf.position[1], kf.position[2]);
      quat.set(out.rotation, kf.rotation[0], kf.rotation[1], kf.rotation[2], kf.rotation[3]);
      vec3.set(out.scale, kf.scale[0], kf.scale[1], kf.scale[2]);
      return;
    }

    // Find surrounding keyframes
    let hi = kfs.length - 1;
    for (let i = 1; i < kfs.length; i++) {
      if (kfs[i]!.time >= time) {
        hi = i;
        break;
      }
    }
    const lo = hi - 1;
    const kfA = kfs[lo]!;
    const kfB = kfs[hi]!;
    const span = kfB.time - kfA.time;
    const t = span > 0 ? (time - kfA.time) / span : 0;

    vec3.set(
      out.position,
      kfA.position[0] + (kfB.position[0] - kfA.position[0]) * t,
      kfA.position[1] + (kfB.position[1] - kfA.position[1]) * t,
      kfA.position[2] + (kfB.position[2] - kfA.position[2]) * t,
    );

    const qA = quat.fromValues(kfA.rotation[0], kfA.rotation[1], kfA.rotation[2], kfA.rotation[3]);
    const qB = quat.fromValues(kfB.rotation[0], kfB.rotation[1], kfB.rotation[2], kfB.rotation[3]);
    quat.slerp(out.rotation, qA, qB, t);

    vec3.set(
      out.scale,
      kfA.scale[0] + (kfB.scale[0] - kfA.scale[0]) * t,
      kfA.scale[1] + (kfB.scale[1] - kfA.scale[1]) * t,
      kfA.scale[2] + (kfB.scale[2] - kfA.scale[2]) * t,
    );
  }

  private resetPose(out: ViewModelPose): void {
    vec3.set(out.position, 0, 0, 0);
    quat.identity(out.rotation);
    vec3.set(out.scale, 1, 1, 1);
  }
}
