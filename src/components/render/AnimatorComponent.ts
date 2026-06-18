import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { SkeletalMeshComponent } from './SkeletalMeshComponent';
import { SkeletonData, AnimationClip, AnimationChannel } from '../../types/SkinData.type';
import { mat4, quat, vec3 } from 'gl-matrix';

// ─── JSON data expected in scene file ────────────────────────────────────────

export interface AnimatorStateData {
  name: string;
  clip: number | string;
  loop?: boolean;
  speed?: number;
}

export interface AnimatorTransitionData {
  from: string;
  to: string;
  /** Bool parameter name that must be true to activate this transition. */
  condition?: string;
  /** Bool parameter name that must be false to activate this transition. */
  conditionFalse?: string;
  /** Trigger name that fires this transition (auto-reset after use). */
  trigger?: string;
  blendTime?: number;
}

export interface AnimatorComponentData {
  states?: AnimatorStateData[];
  default?: string;
  transitions?: AnimatorTransitionData[];
  extraAnimations?: string[];
  autoPlayInterval?: {
    clip: string | number;
    intervalSeconds: number;
    blendTime?: number;
  };
}

// ─── Animation layer options (public API) ────────────────────────────────────

export interface AnimLayerOptions {
  weight?: number;
  blendInTime?: number;
  loop?: boolean;
  speed?: number;
  jointMask?: string[];
}

interface InternalAnimLayer {
  id: number;
  clipIndex: number;
  time: number;
  weight: number;
  currentWeight: number;
  blendInTime: number;
  fadingOut: boolean;
  fadeOutDuration: number;
  fadeOutElapsed: number;
  loop: boolean;
  speed: number;
  jointMask: boolean[] | null;
}

export type RootMotionMode = 'none' | 'extract' | 'apply';

// ─── IK constraint types ──────────────────────────────────────────────────────

export interface LookAtConstraint {
  type: 'lookat';
  jointName: string;
  target: vec3;
  forwardAxis?: vec3;
  weight: number;
  limitAngleDeg?: number;
}

export interface TwoBoneIkConstraint {
  type: 'twobone';
  rootJointName: string;
  midJointName: string;
  tipJointName: string;
  target: vec3;
  poleTarget?: vec3;
  weight: number;
}

export interface ProceduralOffsetConstraint {
  type: 'procedural_offset';
  jointName: string;
  translationOffset?: vec3;
  rotationOffset?: quat;
  weight: number;
}

export type IkConstraint = LookAtConstraint | TwoBoneIkConstraint | ProceduralOffsetConstraint;

// ─── State machine runtime types ──────────────────────────────────────────────

interface RuntimeState {
  name: string;
  clipIndex: number;
  loop: boolean;
  speed: number;
}

interface RuntimeTransition {
  from: string;
  to: string;
  condition?: string;
  conditionFalse?: string;
  trigger?: string;
  blendTime: number;
}

const MAX_JOINTS = 128;

// Minimal GLTF JSON types for raw animation parsing
interface GltfRawJson {
  nodes?: { name?: string }[];
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node?: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
}

/**
 * AnimatorComponent — drives a SkeletalMeshComponent with a state machine.
 *
 * Responsibilities:
 *   - Maintains a simple state machine (states + transitions + bool/trigger params)
 *   - Evaluates clips, crossfades, override layers, and IK every frame
 *   - Calls SkeletalMeshComponent.uploadPose() with the final joint palette
 *
 * Must be on the same entity as a SkeletalMeshComponent.
 * Depends on SkeletalMeshComponent being loaded first — resolves in onAttach().
 */
export class AnimatorComponent extends Component {
  private skeletalMesh!: SkeletalMeshComponent;

  // Skeleton data (shortcut references to asset)
  private skeleton!: SkeletonData;
  private jointCount: number = 0;
  private evalOrder: number[] = [];
  private rootJointIndex: number = -1;
  private rootPreRotation: quat = quat.create();

  // Animation clips (base + extra)
  private clips: AnimationClip[] = [];

  // Per-joint CPU working buffers
  private localT: Float32Array[] = [];
  private localR: Float32Array[] = [];
  private localS: Float32Array[] = [];
  private tempT: Float32Array[] = [];
  private tempR: Float32Array[] = [];
  private tempS: Float32Array[] = [];
  private globalMats: mat4[] = [];
  /** Snapshot of globalMats taken after animation eval but before IK — used by foot IK. */
  private baseAnimGlobalMats: mat4[] = [];
  private jointPalette: Float32Array = new Float32Array(MAX_JOINTS * 16);

  // Base clip playback
  private activeClipIndex: number = 0;
  private playbackTime: number = 0;
  private loop: boolean = true;
  private playbackSpeed: number = 1.0;
  private playing: boolean = true;

  // Crossfade (base-layer transition)
  private crossfadeFrom: { clipIndex: number; time: number } | null = null;
  private crossfadeDuration: number = 0;
  private crossfadeElapsed: number = 0;

  // Override layers
  private animLayers: InternalAnimLayer[] = [];
  private nextLayerId: number = 0;

  // Auto-play interval
  private autoPlayIntervalSeconds: number = 0;
  private autoPlayClip: string | number | null = null;
  private autoPlayBlendTime: number = 0.2;
  private autoPlayTimer: number = 0;

  // Root motion
  private rootMotionMode: RootMotionMode = 'none';
  private rootMotionIncludeY: boolean = false;
  private rootMotionDelta: vec3 = vec3.create();
  private prevRootLocalT: Float32Array = new Float32Array(3);
  private _rootMotionFirstFrame: boolean = true;
  private _rootMotionDidLoop: boolean = false;

  // Additive bone rotations — applied to localR BEFORE global matrix computation,
  // completely separate from IK. Used by hit-warp, procedural animation, etc.
  // Values are Float32Array[4] quaternions (x,y,z,w).
  private readonly additiveRotations = new Map<number, Float32Array>();

  // IK constraints
  private ikConstraints: IkConstraint[] = [];
  private _ikFrozenJoints: Set<number> = new Set();
  // Pre-IK bone offsets applied and propagated before the constraint loop (e.g. pelvis).
  private readonly preIkOffsets = new Map<number, vec3>();

  // State machine
  private states: Map<string, RuntimeState> = new Map();
  private transitions: RuntimeTransition[] = [];
  private currentStateName: string = '';
  private params: Map<string, boolean> = new Map();
  private activeTriggers: Set<string> = new Set();

  // Stored JSON data — consumed in onAttach
  private _data: AnimatorComponentData = {};

  // Extra animation static cache (keyed by filename)
  private static readonly extraAnimCache = new Map<string, AnimationClip[]>();

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: AnimatorComponentData): void {
    this._data = data;
  }

  public override async onAttach(): Promise<void> {
    const skelMesh = this.getOwner().getComponent('skeletal_mesh') as SkeletalMeshComponent;
    if (!skelMesh) {
      console.error('[AnimatorComponent] No SkeletalMeshComponent found on the same entity.');
      return;
    }
    this.skeletalMesh = skelMesh;
    const asset = skelMesh.asset;

    this.skeleton = asset.skeleton;
    this.jointCount = asset.skeleton.joints.length;
    this.evalOrder = asset.evalOrder;
    this.rootJointIndex = asset.rootJointIndex;
    quat.copy(this.rootPreRotation, asset.rootPreRotation as unknown as quat);

    // Base clips (shallow copy — extra animations appended per-instance)
    this.clips = [...asset.clips];

    if (this._data.extraAnimations && this._data.extraAnimations.length > 0) {
      await this.loadExtraAnimations(this._data.extraAnimations);
    }

    // Preallocate CPU working buffers
    for (let i = 0; i < this.jointCount; i++) {
      this.localT.push(new Float32Array([0, 0, 0]));
      this.localR.push(new Float32Array([0, 0, 0, 1]));
      this.localS.push(new Float32Array([1, 1, 1]));
      this.tempT.push(new Float32Array([0, 0, 0]));
      this.tempR.push(new Float32Array([0, 0, 0, 1]));
      this.tempS.push(new Float32Array([1, 1, 1]));
      this.globalMats.push(mat4.create());
    }

    // Build state machine
    this.buildStateMachine(this._data);

    // Auto-play interval
    if (this._data.autoPlayInterval) {
      this.autoPlayClip = this._data.autoPlayInterval.clip;
      this.autoPlayIntervalSeconds = this._data.autoPlayInterval.intervalSeconds;
      this.autoPlayBlendTime = this._data.autoPlayInterval.blendTime ?? 0.2;
    }

    // Initial pose upload
    this.evaluateAnimation(0);
    this.skeletalMesh.uploadPose(this.jointPalette);
  }

  private buildStateMachine(data: AnimatorComponentData): void {
    // If no state machine declared, fall back to simple single-clip playback
    // using the first clip in the asset.
    if (!data.states || data.states.length === 0) {
      this.activeClipIndex = 0;
      this.loop = true;
      return;
    }

    for (const sd of data.states) {
      let clipIndex: number;
      if (typeof sd.clip === 'string') {
        const idx = this.clips.findIndex((c) => c.name === sd.clip);
        clipIndex = idx >= 0 ? idx : 0;
      } else {
        clipIndex = Math.min(sd.clip, this.clips.length - 1);
      }
      this.states.set(sd.name, {
        name: sd.name,
        clipIndex,
        loop: sd.loop ?? true,
        speed: sd.speed ?? 1.0,
      });
    }

    for (const td of data.transitions ?? []) {
      this.transitions.push({
        from: td.from,
        to: td.to,
        condition: td.condition,
        conditionFalse: td.conditionFalse,
        trigger: td.trigger,
        blendTime: td.blendTime ?? 0.2,
      });
    }

    // Enter default state
    const defaultName = data.default ?? data.states[0]!.name;
    this.enterState(defaultName, true);
  }

  private enterState(name: string, instant: boolean = false): void {
    const state = this.states.get(name);
    if (!state) return;

    const blendTime = instant ? 0 : (this.transitions.find(
      (t) => t.from === this.currentStateName && t.to === name,
    )?.blendTime ?? 0.2);

    this.play(state.clipIndex, blendTime);
    this.loop = state.loop;
    this.playbackSpeed = state.speed;
    this.currentStateName = name;
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  private paused: boolean = false;

  public setPaused(v: boolean): void { this.paused = v; }
  public isPaused(): boolean { return this.paused; }

  public update(dt: number): void {
    if (this.paused) return; // hit stop: GPU keeps last uploaded pose, time frozen
    if (!this.playing || this.clips.length === 0) return;

    // State machine: check transitions
    this.evaluateStateMachine();

    // Auto-play interval
    if (this.autoPlayIntervalSeconds > 0 && this.autoPlayClip !== null) {
      this.autoPlayTimer += dt;
      if (this.autoPlayTimer >= this.autoPlayIntervalSeconds) {
        this.autoPlayTimer = 0;
        this.addLayer(this.autoPlayClip, {
          weight: 1.0,
          blendInTime: this.autoPlayBlendTime,
          loop: false,
          speed: 1.0,
        });
      }
    }

    // Advance base clip
    const clip = this.clips[this.activeClipIndex];
    if (!clip) return;

    this.playbackTime += dt * this.playbackSpeed;
    if (this.playbackTime > clip.duration) {
      if (this.loop) {
        this.playbackTime = this.playbackTime % clip.duration;
        this._rootMotionDidLoop = true;
      } else {
        this.playbackTime = clip.duration;
        this.playing = false;
      }
    }

    // Advance crossfade
    if (this.crossfadeFrom) {
      this.crossfadeElapsed += dt;
      const fromClip = this.clips[this.crossfadeFrom.clipIndex];
      if (fromClip) {
        this.crossfadeFrom.time += dt * this.playbackSpeed;
        if (this.crossfadeFrom.time > fromClip.duration) {
          this.crossfadeFrom.time = this.crossfadeFrom.time % fromClip.duration;
        }
      }
      if (this.crossfadeElapsed >= this.crossfadeDuration) this.crossfadeFrom = null;
    }

    // Advance layers
    for (let i = this.animLayers.length - 1; i >= 0; i--) {
      const layer = this.animLayers[i]!;
      const layerClip = this.clips[layer.clipIndex];
      if (!layerClip) continue;

      layer.time += dt * layer.speed;
      if (layer.time > layerClip.duration) {
        if (layer.loop) {
          layer.time = layer.time % layerClip.duration;
        } else {
          layer.time = layerClip.duration;
          if (!layer.fadingOut) {
            layer.fadingOut = true;
            layer.fadeOutDuration = layer.blendInTime > 0 ? layer.blendInTime : 0;
            layer.fadeOutElapsed = 0;
          }
        }
      }

      if (!layer.fadingOut) {
        layer.currentWeight = layer.blendInTime > 0
          ? Math.min(layer.currentWeight + dt / layer.blendInTime, layer.weight)
          : layer.weight;
      } else {
        layer.fadeOutElapsed += dt;
        layer.currentWeight = layer.fadeOutDuration > 0
          ? layer.weight * Math.max(1 - layer.fadeOutElapsed / layer.fadeOutDuration, 0)
          : 0;
        if (layer.currentWeight <= 0) {
          this.animLayers.splice(i, 1);
          continue;
        }
      }
    }

    this.evaluateAnimation(this.playbackTime);
    this.skeletalMesh.uploadPose(this.jointPalette);
  }

  private evaluateStateMachine(): void {
    if (this.states.size === 0) return;

    for (const t of this.transitions) {
      if (t.from !== this.currentStateName) continue;

      let conditionMet = false;
      if (t.trigger && this.activeTriggers.has(t.trigger)) {
        conditionMet = true;
        this.activeTriggers.delete(t.trigger);
      } else if (t.condition && this.params.get(t.condition) === true) {
        conditionMet = true;
      } else if (t.conditionFalse && this.params.get(t.conditionFalse) !== true) {
        conditionMet = true;
      }

      if (conditionMet && this.states.has(t.to)) {
        this.enterState(t.to);
        break;
      }
    }
  }

  public renderDebug(): void {}

  public override dispose(): void {}

  // ─── Public animation API ────────────────────────────────────────────────────

  public play(indexOrName?: number | string, blendTime: number = 0): void {
    let targetIndex = this.activeClipIndex;
    if (indexOrName !== undefined) {
      if (typeof indexOrName === 'string') {
        const idx = this.clips.findIndex((c) => c.name === indexOrName);
        if (idx >= 0) targetIndex = idx;
      } else {
        targetIndex = Math.min(indexOrName, this.clips.length - 1);
      }
    }

    if (blendTime > 0 && targetIndex !== this.activeClipIndex) {
      this.crossfadeFrom = { clipIndex: this.activeClipIndex, time: this.playbackTime };
      this.crossfadeDuration = blendTime;
      this.crossfadeElapsed = 0;
    } else {
      this.crossfadeFrom = null;
    }

    this.activeClipIndex = targetIndex;
    this.playbackTime = 0;
    this.playing = true;
    this._rootMotionFirstFrame = true;
  }

  public addLayer(clipIndexOrName: number | string, options?: AnimLayerOptions): number {
    let clipIndex: number;
    if (typeof clipIndexOrName === 'string') {
      const lower = clipIndexOrName.toLowerCase();
      const idx = this.clips.findIndex((c) => c.name.toLowerCase() === lower);
      if (idx < 0) {
        console.warn(`[Animator] addLayer: clip "${clipIndexOrName}" not found. Available:`,
          this.clips.map((c) => `"${c.name}"`).join(', '));
        return -1;
      }
      clipIndex = idx;
    } else {
      clipIndex = Math.min(clipIndexOrName, this.clips.length - 1);
    }

    const weight = options?.weight ?? 1.0;
    const blendInTime = options?.blendInTime ?? 0;

    let jointMask: boolean[] | null = null;
    if (options?.jointMask && options.jointMask.length > 0) {
      jointMask = new Array(this.jointCount).fill(false);
      for (const name of options.jointMask) {
        const idx = this.skeleton.names.indexOf(name);
        if (idx >= 0) this.markJointAndChildren(idx, jointMask);
      }
    }

    const id = this.nextLayerId++;
    this.animLayers.push({
      id,
      clipIndex,
      time: 0,
      weight,
      currentWeight: blendInTime > 0 ? 0 : weight,
      blendInTime,
      fadingOut: false,
      fadeOutDuration: 0,
      fadeOutElapsed: 0,
      loop: options?.loop ?? true,
      speed: options?.speed ?? 1.0,
      jointMask,
    });
    return id;
  }

  public removeLayer(id: number, fadeOutTime: number = 0): void {
    const layer = this.animLayers.find((l) => l.id === id);
    if (!layer) return;

    if (fadeOutTime > 0 && !layer.fadingOut) {
      layer.fadingOut = true;
      layer.fadeOutDuration = fadeOutTime;
      layer.fadeOutElapsed = 0;
    } else {
      const idx = this.animLayers.findIndex((l) => l.id === id);
      if (idx >= 0) this.animLayers.splice(idx, 1);
    }
  }

  public setLayerWeight(id: number, weight: number): void {
    const layer = this.animLayers.find((l) => l.id === id);
    if (layer) layer.weight = Math.max(0, Math.min(1, weight));
  }

  public setRootMotion(mode: RootMotionMode, includeY: boolean = false): void {
    this.rootMotionMode = mode;
    this.rootMotionIncludeY = includeY;
    this._rootMotionFirstFrame = true;
    vec3.set(this.rootMotionDelta, 0, 0, 0);
  }

  public getRootMotionDelta(): Readonly<vec3> {
    return this.rootMotionDelta;
  }

  /** Set a bool parameter used by transitions. */
  public setParameter(name: string, value: boolean): void {
    this.params.set(name, value);
  }

  /** Fire a trigger (auto-reset after one state machine evaluation). */
  public setTrigger(name: string): void {
    this.activeTriggers.add(name);
  }

  public pause(): void { this.playing = false; }
  public resume(): void { this.playing = true; }
  public setSpeed(s: number): void { this.playbackSpeed = s; }
  public getClips(): string[] { return this.clips.map((c) => c.name); }
  public hasClip(name: string): boolean {
    return this.clips.some((c) => c.name.toLowerCase() === name.toLowerCase());
  }

  // ─── Joint access (for FootIKComponent and external IK systems) ─────────────

  /** Returns the joint index for the given name, or -1 if not found / not yet loaded. */
  public getJointIndex(name: string): number {
    return this.skeleton?.names.indexOf(name) ?? -1;
  }

  public getAllJointNames(): string[] {
    return this.skeleton?.names ?? [];
  }

  /**
   * Returns the joint's current model-space matrix (local to the mesh entity).
   * Only valid AFTER the first evaluateAnimation() call (i.e. after onAttach).
   */
  public getJointModelMatrix(jointIndex: number): Readonly<mat4> | null {
    return this.globalMats[jointIndex] ?? null;
  }

  /** Returns the joint matrix from the BASE animation pose (before any IK constraints).
   *  Use this for raycasts / offset computation in foot IK to avoid feedback loops. */
  public getJointBaseAnimModelMatrix(jointIndex: number): Readonly<mat4> | null {
    return this.baseAnimGlobalMats[jointIndex] ?? null;
  }

  // ─── Additive rotation API ───────────────────────────────────────────────────

  /**
   * Sets an additive rotation on a joint (applied in joint-local space, post-multiply).
   * pitchDeg = X rotation (forward/back lean), rollDeg = Z rotation (left/right lean).
   * Replaces any existing additive rotation for this joint.
   */
  public setAdditiveRotation(jointName: string, pitchDeg: number, rollDeg: number): void {
    const idx = this.getJointIndex(jointName);
    if (idx < 0) return;
    let arr = this.additiveRotations.get(idx);
    if (!arr) { arr = new Float32Array(4); this.additiveRotations.set(idx, arr); }
    const q = quat.create();
    (quat as any).fromEuler(q, pitchDeg, 0, rollDeg);
    arr.set(q as unknown as Float32Array);
  }

  /** Removes the additive rotation for a joint, returning it to its animated pose. */
  public clearAdditiveRotation(jointName: string): void {
    const idx = this.getJointIndex(jointName);
    if (idx >= 0) this.additiveRotations.delete(idx);
  }

  /** Removes all additive rotations at once. */
  public clearAllAdditiveRotations(): void { this.additiveRotations.clear(); }

  // ─── IK API ─────────────────────────────────────────────────────────────────

  public addIkConstraint<T extends IkConstraint>(constraint: T): T {
    this.ikConstraints.push(constraint);
    return constraint;
  }

  public removeIkConstraint(constraint: IkConstraint): void {
    const idx = this.ikConstraints.indexOf(constraint);
    if (idx >= 0) this.ikConstraints.splice(idx, 1);
  }

  public clearIkConstraints(): void {
    this.ikConstraints.length = 0;
  }

  /** Set a translation offset (model space) applied and propagated BEFORE the IK constraint pass. */
  public setPreIkBoneOffset(boneName: string, offset: vec3): void {
    if (!this.skeleton) return;
    const idx = this.skeleton.names.indexOf(boneName);
    if (idx >= 0) this.preIkOffsets.set(idx, offset);
  }

  // ─── Animation evaluation ────────────────────────────────────────────────────

  private evaluateClip(
    clipIndex: number,
    time: number,
    outT: Float32Array[],
    outR: Float32Array[],
    outS: Float32Array[],
  ): void {
    const bp = this.skeleton.bindPoseLocal;
    for (let i = 0; i < this.jointCount; i++) {
      const off = i * 10;
      outT[i]!.set([bp[off]!, bp[off + 1]!, bp[off + 2]!]);
      outR[i]!.set([bp[off + 3]!, bp[off + 4]!, bp[off + 5]!, bp[off + 6]!]);
      outS[i]!.set([bp[off + 7]!, bp[off + 8]!, bp[off + 9]!]);
    }
    const clip = this.clips[clipIndex];
    if (!clip) return;
    for (const channel of clip.channels) {
      const { jointIndex, path, times, values, interpolation } = channel;
      if (jointIndex >= this.jointCount) continue;
      if (path === 'translation') sampleVec3(times, values, time, interpolation, outT[jointIndex]!);
      else if (path === 'rotation') sampleQuat(times, values, time, interpolation, outR[jointIndex]!);
      else if (path === 'scale') sampleVec3(times, values, time, interpolation, outS[jointIndex]!);
    }
  }

  private evaluateAnimation(time: number): void {
    // Step 1: active clip
    this.evaluateClip(this.activeClipIndex, time, this.localT, this.localR, this.localS);

    // Step 2: crossfade blend
    if (this.crossfadeFrom) {
      const alpha = Math.min(this.crossfadeElapsed / this.crossfadeDuration, 1.0);
      this.evaluateClip(this.crossfadeFrom.clipIndex, this.crossfadeFrom.time, this.tempT, this.tempR, this.tempS);
      for (let i = 0; i < this.jointCount; i++) {
        const lT = this.localT[i]!, tT = this.tempT[i]!;
        lT[0] = tT[0]! + (lT[0]! - tT[0]!) * alpha;
        lT[1] = tT[1]! + (lT[1]! - tT[1]!) * alpha;
        lT[2] = tT[2]! + (lT[2]! - tT[2]!) * alpha;
        const lS = this.localS[i]!, tS = this.tempS[i]!;
        lS[0] = tS[0]! + (lS[0]! - tS[0]!) * alpha;
        lS[1] = tS[1]! + (lS[1]! - tS[1]!) * alpha;
        lS[2] = tS[2]! + (lS[2]! - tS[2]!) * alpha;
        quat.slerp(this.localR[i] as any, this.tempR[i] as any, this.localR[i] as any, alpha);
      }
    }

    // Step 3: override layers
    for (const layer of this.animLayers) {
      if (layer.currentWeight <= 0) continue;
      this.evaluateClip(layer.clipIndex, layer.time, this.tempT, this.tempR, this.tempS);
      const w = layer.currentWeight;
      for (let i = 0; i < this.jointCount; i++) {
        if (layer.jointMask && !layer.jointMask[i]) continue;
        const lT = this.localT[i]!, tT = this.tempT[i]!;
        const lT0 = lT[0]!, lT1 = lT[1]!, lT2 = lT[2]!;
        lT[0] = lT0 + (tT[0]! - lT0) * w;
        lT[1] = lT1 + (tT[1]! - lT1) * w;
        lT[2] = lT2 + (tT[2]! - lT2) * w;
        const lS = this.localS[i]!, tS = this.tempS[i]!;
        const lS0 = lS[0]!, lS1 = lS[1]!, lS2 = lS[2]!;
        lS[0] = lS0 + (tS[0]! - lS0) * w;
        lS[1] = lS1 + (tS[1]! - lS1) * w;
        lS[2] = lS2 + (tS[2]! - lS2) * w;
        quat.slerp(this.localR[i] as any, this.localR[i] as any, this.tempR[i] as any, w);
      }
    }

    // Step 3.5: additive bone rotations (hit warp, procedural overlay)
    // Post-multiply into localR so the additive rotation is in joint-local space,
    // cleanly separate from both override layers and IK constraints.
    if (this.additiveRotations.size > 0) {
      for (const [idx, addQ] of this.additiveRotations) {
        if (idx >= this.jointCount) continue;
        const lr = this.localR[idx]!;
        const result = quat.mul(quat.create() as any, lr as any, addQ as any) as unknown as Float32Array;
        quat.normalize(result as any, result as any);
        lr.set(result);
      }
    }

    // Step 4: root motion extraction
    if (this.rootMotionMode !== 'none' && this.rootJointIndex >= 0) {
      const rootT = this.localT[this.rootJointIndex]!;

      if (this._rootMotionFirstFrame || this._rootMotionDidLoop) {
        this.prevRootLocalT.set(rootT);
        vec3.set(this.rootMotionDelta, 0, 0, 0);
        this._rootMotionFirstFrame = false;
        this._rootMotionDidLoop = false;
      } else {
        const dx = rootT[0]! - this.prevRootLocalT[0]!;
        const dy = this.rootMotionIncludeY ? rootT[1]! - this.prevRootLocalT[1]! : 0;
        const dz = rootT[2]! - this.prevRootLocalT[2]!;
        const delta = vec3.fromValues(dx, dy, dz);
        vec3.transformQuat(delta, delta, this.rootPreRotation as unknown as quat);
        const ownerTransform = (
          this.getOwner().getComponent('transform') as TransformComponent | null
        )?.getTransform();
        if (ownerTransform) {
          vec3.transformQuat(delta, delta, ownerTransform.getWorldRotation());
        }
        vec3.copy(this.rootMotionDelta, delta);
        this.prevRootLocalT.set(rootT);
      }

      const bp = this.skeleton.bindPoseLocal;
      const bpOff = this.rootJointIndex * 10;
      this.localT[this.rootJointIndex]!.set([bp[bpOff]!, bp[bpOff + 1]!, bp[bpOff + 2]!]);

      if (this.rootMotionMode === 'apply') {
        const ownerTransform = (
          this.getOwner().getComponent('transform') as TransformComponent | null
        )?.getTransform();
        if (ownerTransform) {
          const pos = ownerTransform.getLocalPosition();
          ownerTransform.setLocalPosition(vec3.add(vec3.create(), pos, this.rootMotionDelta));
        }
      }
    }

    // Step 5: compute global matrices
    const parents = this.skeleton.parents;
    const rootPre = this.skeleton.rootPreTransform as unknown as mat4;

    for (const i of this.evalOrder) {
      const local = mat4.fromRotationTranslationScale(
        mat4.create(),
        this.localR[i] as any,
        this.localT[i] as any,
        this.localS[i] as any,
      );
      const parentIdx = parents[i]!;
      if (parentIdx < 0) {
        this.globalMats[i] = mat4.mul(mat4.create(), rootPre, local);
      } else {
        this.globalMats[i] = mat4.mul(mat4.create(), this.globalMats[parentIdx]!, local);
      }
    }

    // Snapshot base-anim pose before IK so foot IK (and other systems) can read
    // the pure animation position without the previous frame's IK baked in.
    for (let i = 0; i < this.jointCount; i++) {
      if (!this.baseAnimGlobalMats[i]) this.baseAnimGlobalMats[i] = mat4.create();
      mat4.copy(this.baseAnimGlobalMats[i]!, this.globalMats[i]!);
    }

    // Step 6: IK constraints
    if (this.ikConstraints.length > 0) this.applyIkConstraints();

    // Step 7: joint palette
    const ibm = this.skeleton.inverseBindMatrices;
    for (let i = 0; i < this.jointCount; i++) {
      const ibmSlice = ibm.subarray(i * 16, i * 16 + 16) as unknown as mat4;
      this.jointPalette.set(mat4.mul(mat4.create(), this.globalMats[i]!, ibmSlice), i * 16);
    }
  }

  private markJointAndChildren(jointIdx: number, mask: boolean[]): void {
    mask[jointIdx] = true;
    const parents = this.skeleton.parents;
    for (let i = 0; i < this.jointCount; i++) {
      if (parents[i] === jointIdx && !mask[i]) this.markJointAndChildren(i, mask);
    }
  }

  // ─── IK solvers (ported from SkinnedMeshComponent) ───────────────────────────

  private applyIkConstraints(): void {
    this._ikFrozenJoints.clear();

    // Pre-IK pass: apply bone offsets (e.g. pelvis) and propagate to children so
    // TwoBoneIK sees the updated leg root positions.
    if (this.preIkOffsets.size > 0) {
      for (const [idx, offset] of this.preIkOffsets) {
        const M = this.globalMats[idx]!;
        (M as Float32Array)[12] += offset[0];
        (M as Float32Array)[13] += offset[1];
        (M as Float32Array)[14] += offset[2];
        this._ikFrozenJoints.add(idx);
      }
      this.repropagateMats();
      // Keep only the directly-offset joints frozen so the final repropagateMats
      // preserves them (torso follows pelvis down) while letting TwoBoneIK work
      // on the children and the final pass propagates feet from IK knees.
      const preIkRoots = new Set<number>(this.preIkOffsets.keys());
      this._ikFrozenJoints.clear();
      for (const idx of preIkRoots) this._ikFrozenJoints.add(idx);
      this.preIkOffsets.clear();
    }

    for (const c of this.ikConstraints) {
      if (c.weight <= 0) continue;
      if (c.type === 'lookat') this.applyLookAt(c);
      else if (c.type === 'twobone') this.applyTwoBoneIK(c);
      else if (c.type === 'procedural_offset') this.applyProceduralOffset(c);
    }
    if (this._ikFrozenJoints.size > 0) this.repropagateMats();
  }

  private repropagateMats(): void {
    const parents = this.skeleton.parents;
    const rootPre = this.skeleton.rootPreTransform as unknown as mat4;
    for (const i of this.evalOrder) {
      if (this._ikFrozenJoints.has(i)) continue;
      const parentIdx = parents[i]!;
      if (parentIdx >= 0 && !this._ikFrozenJoints.has(parentIdx)) continue;
      const local = mat4.fromRotationTranslationScale(mat4.create(), this.localR[i] as any, this.localT[i] as any, this.localS[i] as any);
      if (parentIdx < 0) {
        this.globalMats[i] = mat4.mul(mat4.create(), rootPre, local);
      } else {
        this.globalMats[i] = mat4.mul(mat4.create(), this.globalMats[parentIdx]!, local);
      }
      this._ikFrozenJoints.add(i);
    }
  }

  private applyLookAt(c: LookAtConstraint): void {
    const jointIdx = this.skeleton.names.indexOf(c.jointName);
    if (jointIdx < 0) return;
    const M = this.globalMats[jointIdx]!;
    const pos = vec3.fromValues(M[12]!, M[13]!, M[14]!);
    const toTarget = vec3.sub(vec3.create(), c.target, pos);
    const dist = vec3.length(toTarget);
    if (dist < 0.0001) return;
    vec3.scale(toTarget, toTarget, 1.0 / dist);
    const currentRot = quat.create();
    mat4.getRotation(currentRot as unknown as quat, M as unknown as mat4);
    quat.normalize(currentRot as unknown as quat, currentRot as unknown as quat);
    const fwdLocal = c.forwardAxis ?? [0, 0, 1];
    const worldFwd = vec3.transformQuat(vec3.create(), fwdLocal as vec3, currentRot as unknown as quat);
    const q = quat.create();
    quat.rotationTo(q as unknown as quat, worldFwd, toTarget);
    if (c.limitAngleDeg !== undefined) {
      const limitRad = c.limitAngleDeg * (Math.PI / 180);
      const w = Math.min(1, Math.abs((q as unknown as Float32Array)[3]!));
      const angle = 2 * Math.acos(w);
      if (angle > limitRad && angle > 0.0001) {
        quat.slerp(q as unknown as quat, quat.create() as unknown as quat, q as unknown as quat, limitRad / angle);
      }
    }
    quat.slerp(q as unknown as quat, quat.create() as unknown as quat, q as unknown as quat, c.weight);
    const newRot = quat.mul(quat.create() as unknown as quat, q as unknown as quat, currentRot as unknown as quat);
    quat.normalize(newRot as unknown as quat, newRot as unknown as quat);
    const scale = vec3.create();
    mat4.getScaling(scale, M as unknown as mat4);
    mat4.fromRotationTranslationScale(M as unknown as mat4, newRot as unknown as quat, pos, scale);
    this._ikFrozenJoints.add(jointIdx);
  }

  private applyTwoBoneIK(c: TwoBoneIkConstraint): void {
    const rootIdx = this.skeleton.names.indexOf(c.rootJointName);
    const midIdx = this.skeleton.names.indexOf(c.midJointName);
    const tipIdx = this.skeleton.names.indexOf(c.tipJointName);
    if (rootIdx < 0 || midIdx < 0 || tipIdx < 0) return;
    const MR = this.globalMats[rootIdx]!;
    const MM = this.globalMats[midIdx]!;
    const MT = this.globalMats[tipIdx]!;
    const pA = vec3.fromValues(MR[12]!, MR[13]!, MR[14]!);
    const pB = vec3.fromValues(MM[12]!, MM[13]!, MM[14]!);
    const pC = vec3.fromValues(MT[12]!, MT[13]!, MT[14]!);
    const d1 = vec3.distance(pA, pB);
    const d2 = vec3.distance(pB, pC);
    if (d1 < 0.0001 || d2 < 0.0001) return;
    const toTarget = vec3.sub(vec3.create(), c.target, pA);
    const rawDist = vec3.length(toTarget);
    if (rawDist < 0.0001) return;
    const maxReach = d1 + d2 - 0.001;
    const minReach = Math.abs(d1 - d2) + 0.001;
    const clampedDist = Math.max(minReach, Math.min(maxReach, rawDist));
    const dir = vec3.scale(vec3.create(), toTarget, 1 / rawDist);
    const poleSource = c.poleTarget ?? pB;
    const toPole = vec3.sub(vec3.create(), poleSource, pA);
    const dp = vec3.dot(toPole, dir);
    const polePerp = vec3.sub(vec3.create(), toPole, vec3.scale(vec3.create(), dir, dp));
    const poleLen = vec3.length(polePerp);
    if (poleLen < 0.0001) vec3.set(polePerp, 0, 1, 0);
    else vec3.scale(polePerp, polePerp, 1 / poleLen);
    const cosA = Math.max(-1, Math.min(1, (d1 * d1 + clampedDist * clampedDist - d2 * d2) / (2 * d1 * clampedDist)));
    const angleA = Math.acos(cosA);
    const pB_new = vec3.add(vec3.create(), pA, vec3.add(vec3.create(),
      vec3.scale(vec3.create(), dir, Math.cos(angleA) * d1),
      vec3.scale(vec3.create(), polePerp, Math.sin(angleA) * d1)));
    const pT_adj = vec3.add(vec3.create(), pA, vec3.scale(vec3.create(), dir, clampedDist));
    const origAB = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pB, pA));
    const newAB = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pB_new, pA));
    const qRoot = quat.create();
    quat.rotationTo(qRoot as unknown as quat, origAB, newAB);
    quat.slerp(qRoot as unknown as quat, quat.create() as unknown as quat, qRoot as unknown as quat, c.weight);
    const rootRot = quat.create();
    mat4.getRotation(rootRot as unknown as quat, MR as unknown as mat4);
    quat.normalize(rootRot as unknown as quat, rootRot as unknown as quat);
    const newRootRot = quat.mul(quat.create() as unknown as quat, qRoot as unknown as quat, rootRot as unknown as quat);
    quat.normalize(newRootRot as unknown as quat, newRootRot as unknown as quat);
    const rootScale = vec3.create();
    mat4.getScaling(rootScale, MR as unknown as mat4);
    mat4.fromRotationTranslationScale(MR as unknown as mat4, newRootRot as unknown as quat, pA, rootScale);
    this._ikFrozenJoints.add(rootIdx);
    const pB_final = c.weight < 1 ? vec3.lerp(vec3.create(), pB, pB_new, c.weight) : pB_new;
    const pT_final = c.weight < 1 ? vec3.lerp(vec3.create(), pC, pT_adj, c.weight) : pT_adj;
    const origBC = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pC, pB));
    const newBC = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), pT_final, pB_final));
    const qMid = quat.create();
    quat.rotationTo(qMid as unknown as quat, origBC, newBC);
    const midRot = quat.create();
    mat4.getRotation(midRot as unknown as quat, MM as unknown as mat4);
    quat.normalize(midRot as unknown as quat, midRot as unknown as quat);
    const newMidRot = quat.mul(quat.create() as unknown as quat, qMid as unknown as quat, midRot as unknown as quat);
    quat.normalize(newMidRot as unknown as quat, newMidRot as unknown as quat);
    const midScale = vec3.create();
    mat4.getScaling(midScale, MM as unknown as mat4);
    mat4.fromRotationTranslationScale(MM as unknown as mat4, newMidRot as unknown as quat, pB_final, midScale);
    this._ikFrozenJoints.add(midIdx);
    void tipIdx;
  }

  private applyProceduralOffset(c: ProceduralOffsetConstraint): void {
    const jointIdx = this.skeleton.names.indexOf(c.jointName);
    if (jointIdx < 0) return;
    const M = this.globalMats[jointIdx]!;
    const pos = vec3.fromValues(M[12]!, M[13]!, M[14]!);
    const scale = vec3.create();
    mat4.getScaling(scale, M as unknown as mat4);
    const rot = quat.create();
    mat4.getRotation(rot as unknown as quat, M as unknown as mat4);
    quat.normalize(rot as unknown as quat, rot as unknown as quat);
    if (c.rotationOffset) {
      const blendedRot = quat.slerp(quat.create() as unknown as quat, quat.create() as unknown as quat, c.rotationOffset as unknown as quat, c.weight);
      quat.mul(rot as unknown as quat, rot as unknown as quat, blendedRot as unknown as quat);
      quat.normalize(rot as unknown as quat, rot as unknown as quat);
    }
    if (c.translationOffset) {
      vec3.add(pos, pos, vec3.scale(vec3.create(), c.translationOffset, c.weight));
    }
    mat4.fromRotationTranslationScale(M as unknown as mat4, rot as unknown as quat, pos, scale);
    this._ikFrozenJoints.add(jointIdx);
  }

  // ─── Extra animation loading ─────────────────────────────────────────────────

  private async loadExtraAnimations(paths: string[]): Promise<void> {
    const nameToJointIdx = new Map<string, number>();
    this.skeleton.names.forEach((name, idx) => nameToJointIdx.set(name.toLowerCase(), idx));

    for (const path of paths) {
      const cached = AnimatorComponent.extraAnimCache.get(path);
      if (cached) {
        this.clips.push(...cached);
        continue;
      }

      const url = `assets/animations/${path}`;
      let gltfJson: GltfRawJson;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        gltfJson = (await res.json()) as GltfRawJson;
      } catch (e) {
        console.warn(`[Animator] loadExtraAnimations: could not fetch "${url}"`, e);
        continue;
      }

      const bufferData: ArrayBuffer[] = [];
      for (const buf of gltfJson.buffers ?? []) {
        if (!buf.uri) {
          bufferData.push(new ArrayBuffer(0));
        } else if (buf.uri.startsWith('data:')) {
          const b64 = buf.uri.split(',')[1]!;
          const binary = atob(b64);
          const ab = new ArrayBuffer(binary.length);
          const u8 = new Uint8Array(ab);
          for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
          bufferData.push(ab);
        } else {
          try {
            const r = await fetch(`assets/animations/${buf.uri}`);
            bufferData.push(await r.arrayBuffer());
          } catch {
            bufferData.push(new ArrayBuffer(0));
          }
        }
      }

      const readAccessor = (accIdx: number): Float32Array | null => {
        const acc = gltfJson.accessors?.[accIdx];
        if (!acc || acc.bufferView === undefined) return null;
        const bv = gltfJson.bufferViews?.[acc.bufferView];
        if (!bv) return null;
        const buffer = bufferData[bv.buffer];
        if (!buffer) return null;
        const componentCount = acc.type === 'SCALAR' ? 1 : acc.type === 'VEC2' ? 2 : acc.type === 'VEC3' ? 3 : acc.type === 'VEC4' ? 4 : acc.type === 'MAT4' ? 16 : 1;
        const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const elementBytes = acc.componentType === 5126 ? 4 : 1;
        const totalBytes = acc.count * componentCount * elementBytes;
        if (byteOffset + totalBytes > buffer.byteLength) {
          console.warn(`[Animator] accessor ${accIdx} out of bounds, skipping`);
          return null;
        }
        if (acc.componentType === 5126) return new Float32Array(buffer, byteOffset, acc.count * componentCount);
        const out = new Float32Array(acc.count * componentCount);
        const dv = new DataView(buffer, byteOffset);
        for (let i = 0; i < out.length; i++) out[i] = dv.getUint8(i);
        return out;
      };

      const newClips = (gltfJson.animations ?? []).map((anim) => {
        let duration = 0;
        const channels: AnimationChannel[] = [];
        for (const ch of anim.channels) {
          const nodeIdx = ch.target.node;
          if (nodeIdx === undefined) continue;
          const nodeName = gltfJson.nodes?.[nodeIdx]?.name;
          if (!nodeName) continue;
          const jointIndex = nameToJointIdx.get(nodeName.toLowerCase());
          if (jointIndex === undefined) continue;
          const sampler = anim.samplers[ch.sampler];
          if (!sampler) continue;
          const times = readAccessor(sampler.input);
          const values = readAccessor(sampler.output);
          if (!times || !values) continue;
          const animPath = ch.target.path as 'translation' | 'rotation' | 'scale';
          const interp = (sampler.interpolation ?? 'LINEAR') as AnimationChannel['interpolation'];
          if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
          channels.push({ jointIndex, path: animPath, times: new Float32Array(times), values: new Float32Array(values), interpolation: interp });
        }
        const filenameBase = path.replace(/\.[^.]+$/, '');
        const clipName = !anim.name || anim.name === 'mixamo.com' ? filenameBase : anim.name;
        return { name: clipName, duration, channels };
      });

      AnimatorComponent.extraAnimCache.set(path, newClips);
      this.clips.push(...newClips);
    }
  }
}

// ─── Animation sampling helpers ───────────────────────────────────────────────

function findKeyframe(times: Float32Array, t: number): number {
  let lo = 0, hi = times.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sampleVec3(
  times: Float32Array,
  values: Float32Array,
  t: number,
  interp: AnimationChannel['interpolation'],
  out: Float32Array,
): void {
  const n = times.length;
  if (n === 0) return;
  if (t <= times[0]!) { out.set(values.subarray(0, 3)); return; }
  if (t >= times[n - 1]!) { out.set(values.subarray((n - 1) * 3, n * 3)); return; }
  const i = findKeyframe(times, t);
  const t0 = times[i]!, t1 = times[i + 1]!;
  const alpha = (t - t0) / (t1 - t0);
  if (interp === 'STEP') {
    out.set(values.subarray(i * 3, i * 3 + 3));
  } else {
    const stride = interp === 'CUBICSPLINE' ? 3 : 1;
    const base = interp === 'CUBICSPLINE' ? 1 : 0;
    const i0 = (i * stride + base) * 3;
    const i1 = ((i + 1) * stride + base) * 3;
    out[0] = values[i0]! + (values[i1]! - values[i0]!) * alpha;
    out[1] = values[i0 + 1]! + (values[i1 + 1]! - values[i0 + 1]!) * alpha;
    out[2] = values[i0 + 2]! + (values[i1 + 2]! - values[i0 + 2]!) * alpha;
  }
}

function sampleQuat(
  times: Float32Array,
  values: Float32Array,
  t: number,
  interp: AnimationChannel['interpolation'],
  out: Float32Array,
): void {
  const n = times.length;
  if (n === 0) return;
  if (t <= times[0]!) { out.set(values.subarray(0, 4)); return; }
  if (t >= times[n - 1]!) { out.set(values.subarray((n - 1) * 4, n * 4)); return; }
  const i = findKeyframe(times, t);
  const t0 = times[i]!, t1 = times[i + 1]!;
  const alpha = (t - t0) / (t1 - t0);
  if (interp === 'STEP') {
    out.set(values.subarray(i * 4, i * 4 + 4));
  } else {
    const stride = interp === 'CUBICSPLINE' ? 3 : 1;
    const base = interp === 'CUBICSPLINE' ? 1 : 0;
    const i0 = (i * stride + base) * 4;
    const i1 = ((i + 1) * stride + base) * 4;
    const qa = values.subarray(i0, i0 + 4) as any;
    const qb = values.subarray(i1, i1 + 4) as any;
    out.set(quat.slerp(quat.create(), qa, qb, alpha));
  }
}
