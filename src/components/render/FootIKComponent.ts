import { vec3, mat4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { AnimatorComponent, TwoBoneIkConstraint } from './AnimatorComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

export interface FootIKData {
  leftThigh?: string;
  leftKnee?: string;
  leftFoot?: string;
  rightThigh?: string;
  rightKnee?: string;
  rightFoot?: string;
  /** Pelvis bone — dropped by min(leftOffset, rightOffset) so knees bend on slopes. */
  pelvis?: string;

  /** How far above the animated foot the raycast starts (default 0.3 m). */
  raycastUpOffset?: number;
  /** How far below the animated foot the raycast searches (default 0.5 m). */
  raycastMaxDown?: number;

  /**
   * Height of the ankle joint above the foot sole in the bind pose (metres).
   * For Mixamo characters this is roughly 0.08–0.10 m.
   * If 0, the IK places the ankle exactly on the ground surface.
   */
  ankleHeight?: number;

  /** Exponential-decay speed for per-foot Y offset (default 12). */
  footLerpSpeed?: number;
  /** Exponential-decay speed for pelvis Y offset (default 8 — slower = more natural). */
  pelvisLerpSpeed?: number;

  /** IK influence weight 0–1 (default 1). */
  ikWeight?: number;
}

/**
 * FootIKComponent — places feet on the ground using Two-Bone IK + pelvis adjustment.
 *
 * Pipeline (matches UE5 basic foot IK tutorial):
 *   1. Raycast from each animated foot → get ground Y hit.
 *   2. Smooth per-foot Y offset toward hit (or 0 when no hit = in air or swing phase).
 *   3. Pelvis drops by min(leftOffset, rightOffset, 0) so knees naturally bend on slopes.
 *      Applied as a pre-IK bone offset that propagates to the leg roots before TwoBoneIK runs.
 *   4. TwoBoneIK bends each leg so the foot tip reaches the corrected Y target.
 *
 * Swing-phase filtering: raycastMaxDown (~0.3 m) means a foot high in the air during
 * a stride won't hit ground → offset interpolates to 0 → IK has no effect. No
 * separate threshold needed — the ray length IS the filter.
 */
export class FootIKComponent extends Component {
  // ── Config ───────────────────────────────────────────────────────────────────
  private leftThigh: string = 'mixamorig:LeftUpLeg';
  private leftKnee: string = 'mixamorig:LeftLeg';
  private leftFoot: string = 'mixamorig:LeftFoot';
  private rightThigh: string = 'mixamorig:RightUpLeg';
  private rightKnee: string = 'mixamorig:RightLeg';
  private rightFoot: string = 'mixamorig:RightFoot';
  private pelvis: string = 'mixamorig:Hips';

  private ankleHeight: number = 0.08;
  private raycastUpOffset: number = 0.3;
  private raycastMaxDown: number = 0.5;
  private footLerpSpeed: number = 12;
  private pelvisLerpSpeed: number = 8;
  private ikWeight: number = 1.0;

  // ── Runtime ──────────────────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private leftConstraint: TwoBoneIkConstraint | null = null;
  private rightConstraint: TwoBoneIkConstraint | null = null;

  private leftYOffset: number = 0;
  private rightYOffset: number = 0;
  private pelvisYOffset: number = 0;
  private initialized: boolean = false;

  // ── Debug (read-only, exposed to renderInMenu via .listen()) ──────────────────
  public dbgLeftRaw: number = 0;
  public dbgRightRaw: number = 0;
  public dbgLeftOffset: number = 0;
  public dbgRightOffset: number = 0;
  public dbgPelvisOffset: number = 0;
  public dbgLeftGroundY: number = 0;
  public dbgRightGroundY: number = 0;
  public dbgLeftFootWorldY: number = 0;
  public dbgRightFootWorldY: number = 0;
  private logToConsole: boolean = false;
  private logFrame: number = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  public async load(data: FootIKData): Promise<void> {
    if (data.leftThigh) this.leftThigh = data.leftThigh;
    if (data.leftKnee) this.leftKnee = data.leftKnee;
    if (data.leftFoot) this.leftFoot = data.leftFoot;
    if (data.rightThigh) this.rightThigh = data.rightThigh;
    if (data.rightKnee) this.rightKnee = data.rightKnee;
    if (data.rightFoot) this.rightFoot = data.rightFoot;
    if (data.pelvis) this.pelvis = data.pelvis;
    if (data.ankleHeight !== undefined) this.ankleHeight = data.ankleHeight;
    if (data.raycastUpOffset !== undefined) this.raycastUpOffset = data.raycastUpOffset;
    if (data.raycastMaxDown !== undefined) this.raycastMaxDown = data.raycastMaxDown;
    if (data.footLerpSpeed !== undefined) this.footLerpSpeed = data.footLerpSpeed;
    if (data.pelvisLerpSpeed !== undefined) this.pelvisLerpSpeed = data.pelvisLerpSpeed;
    if (data.ikWeight !== undefined) this.ikWeight = data.ikWeight;
  }

  public override async onAttach(): Promise<void> {
    this.animator = this.getOwner().getComponent('animator') as AnimatorComponent | null;
  }

  public update(dt: number): void {
    if (!this.animator) return;
    if (!this.leftConstraint && !this.tryCreateConstraints()) return;

    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return;

    // Is In Air check: skip IK and fade offsets toward 0 when not grounded.
    // The controller lives on the parent entity; try owner first as fallback.
    const controllerEntity = this.getOwner().getParent() ?? this.getOwner();
    const controller =
      (controllerEntity.getComponent('player_controller') as any) ??
      (this.getOwner().getComponent('player_controller') as any);
    if (controller && controller.getIsGrounded?.() === false) {
      const worldScaleY0 = (transform.getTransform().getWorldScale() as vec3)[1];
      const invScaleY0 = worldScaleY0 > 0 ? 1.0 / worldScaleY0 : 1.0;
      const fadeK = Math.max(0, 1 - dt * this.footLerpSpeed);
      this.leftYOffset *= fadeK;
      this.rightYOffset *= fadeK;
      this.pelvisYOffset *= Math.max(0, 1 - dt * this.pelvisLerpSpeed);
      this.animator.setPreIkBoneOffset(
        this.pelvis,
        vec3.fromValues(0, this.pelvisYOffset * invScaleY0, 0),
      );
      const lm = this.getJointModelPos(this.animator.getJointIndex(this.leftFoot));
      const rm = this.getJointModelPos(this.animator.getJointIndex(this.rightFoot));
      if (lm) vec3.copy(this.leftConstraint!.target, lm);
      if (rm) vec3.copy(this.rightConstraint!.target, rm);
      return;
    }

    // Use the full world matrix (includes scale) so foot world positions are correct
    // even when the character is imported at a non-unit scale (e.g. Mixamo at 0.01).
    const worldMat = transform.getTransform().getWorldMatrix() as mat4;

    const parent = this.getOwner().getParent();
    const capsuleBody: RAPIER.RigidBody | undefined =
      (parent?.getComponent('capsule_collider') as any)?.getRigidBody?.() ?? undefined;

    const leftFootIdx = this.animator.getJointIndex(this.leftFoot);
    const rightFootIdx = this.animator.getJointIndex(this.rightFoot);

    // Base animation foot positions (pre-IK snapshot from this frame's animation eval).
    // These are used for raycasts and delta computation — never post-IK positions,
    // which would create a feedback loop where the corrected foot looks "already correct".
    const leftBaseWorld = this.getJointBaseAnimWorldPos(leftFootIdx, worldMat);
    const rightBaseWorld = this.getJointBaseAnimWorldPos(rightFootIdx, worldMat);
    const leftAnimModel = this.getJointBaseAnimModelPos(leftFootIdx);
    const rightAnimModel = this.getJointBaseAnimModelPos(rightFootIdx);
    if (!leftBaseWorld || !rightBaseWorld || !leftAnimModel || !rightAnimModel) return;

    if (!this.initialized) {
      this.leftConstraint!.weight = this.ikWeight;
      this.rightConstraint!.weight = this.ikWeight;
      this.initialized = true;
    }

    const footAlpha = Math.min(1.0, dt * this.footLerpSpeed);
    const pelvisAlpha = Math.min(1.0, dt * this.pelvisLerpSpeed);

    // ── 1. Raycast each foot from BASE animation position → target world Y ────
    // No hit = swing phase → target = base anim Y → offset decays to 0 naturally.
    const leftGroundY = this.castGroundY(leftBaseWorld, capsuleBody);
    const rightGroundY = this.castGroundY(rightBaseWorld, capsuleBody);

    const leftTargetWorldY =
      leftGroundY !== null ? leftGroundY + this.ankleHeight : leftBaseWorld[1];
    const rightTargetWorldY =
      rightGroundY !== null ? rightGroundY + this.ankleHeight : rightBaseWorld[1];

    // ── 2. Delta from base animation position to target ───────────────────────
    const leftRaw = leftTargetWorldY - leftBaseWorld[1];
    const rightRaw = rightTargetWorldY - rightBaseWorld[1];

    // Smooth the corrections over time (avoids snapping on uneven terrain)
    this.leftYOffset += (leftRaw - this.leftYOffset) * footAlpha;
    this.rightYOffset += (rightRaw - this.rightYOffset) * footAlpha;

    // ── Debug ─────────────────────────────────────────────────────────────────
    this.dbgLeftGroundY = leftGroundY ?? -999;
    this.dbgRightGroundY = rightGroundY ?? -999;
    this.dbgLeftFootWorldY = leftBaseWorld[1];
    this.dbgRightFootWorldY = rightBaseWorld[1];
    this.dbgLeftRaw = leftRaw;
    this.dbgRightRaw = rightRaw;
    this.dbgLeftOffset = this.leftYOffset;
    this.dbgRightOffset = this.rightYOffset;
    this.dbgPelvisOffset = this.pelvisYOffset;
    if (this.logToConsole && ++this.logFrame % 90 === 0) {
      console.log(
        `[FootIK] L ground=${(leftGroundY ?? -999).toFixed(3)} baseY=${leftBaseWorld[1].toFixed(3)} raw=${leftRaw.toFixed(3)} off=${this.leftYOffset.toFixed(3)}` +
          ` | R ground=${(rightGroundY ?? -999).toFixed(3)} baseY=${rightBaseWorld[1].toFixed(3)} raw=${rightRaw.toFixed(3)} off=${this.rightYOffset.toFixed(3)}` +
          ` | pelvis=${this.pelvisYOffset.toFixed(3)}`,
      );
    }

    // ── 3. Lower the pelvis so the downward leg can reach ─────────────────────
    // World-space offsets must be converted to model space before being applied
    // to bone matrices. The character may be imported at a non-unit scale (e.g.
    // Mixamo at 0.01: model units are cm, world units are m). Without dividing
    // by worldScale a -0.2 m correction becomes -0.2 cm — the mesh never moves.
    const worldScaleY = (transform.getTransform().getWorldScale() as vec3)[1];
    const invScaleY = worldScaleY > 0 ? 1.0 / worldScaleY : 1.0;

    const pelvisTarget = Math.min(this.leftYOffset, this.rightYOffset, 0);
    this.pelvisYOffset += (pelvisTarget - this.pelvisYOffset) * pelvisAlpha;
    // pelvisYOffset is in world metres → convert to model space before applying
    this.animator.setPreIkBoneOffset(
      this.pelvis,
      vec3.fromValues(0, this.pelvisYOffset * invScaleY, 0),
    );

    // ── 4. IK targets in model space ──────────────────────────────────────────
    // Same scale conversion: leftYOffset/rightYOffset are world-space deltas,
    // the IK constraint target is read in model space.
    vec3.set(
      this.leftConstraint!.target,
      leftAnimModel[0]!,
      leftAnimModel[1]! + this.leftYOffset * invScaleY,
      leftAnimModel[2]!,
    );
    vec3.set(
      this.rightConstraint!.target,
      rightAnimModel[0]!,
      rightAnimModel[1]! + this.rightYOffset * invScaleY,
      rightAnimModel[2]!,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private tryCreateConstraints(): boolean {
    if (!this.animator) return false;
    if (this.animator.getJointIndex(this.leftThigh) < 0) return false;

    this.leftConstraint = this.animator.addIkConstraint<TwoBoneIkConstraint>({
      type: 'twobone',
      rootJointName: this.leftThigh,
      midJointName: this.leftKnee,
      tipJointName: this.leftFoot,
      target: vec3.create(),
      weight: 0,
    });

    this.rightConstraint = this.animator.addIkConstraint<TwoBoneIkConstraint>({
      type: 'twobone',
      rootJointName: this.rightThigh,
      midJointName: this.rightKnee,
      tipJointName: this.rightFoot,
      target: vec3.create(),
      weight: 0,
    });

    return true;
  }

  /** World position from the BASE animation pose (pre-IK snapshot). Use for raycasts. */
  private getJointBaseAnimWorldPos(jointIdx: number, worldMat: mat4): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointBaseAnimModelMatrix(jointIdx);
    if (!M) return null;
    const combined = mat4.mul(mat4.create(), worldMat, M as mat4);
    return vec3.fromValues(combined[12]!, combined[13]!, combined[14]!);
  }

  /** Model-space position from the BASE animation pose (pre-IK snapshot). Use for IK targets. */
  private getJointBaseAnimModelPos(jointIdx: number): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointBaseAnimModelMatrix(jointIdx);
    if (!M) return null;
    return vec3.fromValues(M[12]!, M[13]!, M[14]!);
  }

  private getJointModelPos(jointIdx: number): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointModelMatrix(jointIdx);
    if (!M) return null;
    return vec3.fromValues(M[12]!, M[13]!, M[14]!);
  }

  private castGroundY(footWorld: vec3, excludeBody?: RAPIER.RigidBody): number | null {
    const physics = Engine.getPhysics();
    if (!physics) return null;

    const originY = footWorld[1] + this.raycastUpOffset;
    const ray = new RAPIER.Ray(
      { x: footWorld[0], y: originY, z: footWorld[2] },
      { x: 0, y: -1, z: 0 },
    );
    const hit = physics
      .getWorld()
      .castRay(
        ray,
        this.raycastUpOffset + this.raycastMaxDown,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        excludeBody,
      );

    return hit ? originY - hit.timeOfImpact : null;
  }

  public override dispose(): void {
    if (this.animator) {
      if (this.leftConstraint) this.animator.removeIkConstraint(this.leftConstraint);
      if (this.rightConstraint) this.animator.removeIkConstraint(this.rightConstraint);
    }
  }

  public override renderInMenu(folder: any): void {
    const f = folder.addFolder('Foot IK');

    // Tweakable params
    f.add(this, 'ankleHeight', 0, 0.3, 0.001).name('Ankle height (m)');
    f.add(this, 'ikWeight', 0, 1, 0.01).name('IK weight');
    f.add(this, 'footLerpSpeed', 1, 30, 1).name('Foot smooth');
    f.add(this, 'pelvisLerpSpeed', 1, 20, 1).name('Pelvis smooth');
    f.add(this, 'raycastMaxDown', 0.05, 1.5, 0.01).name('Ray max down (m)');
    f.add(this, 'logToConsole').name('Log to console');

    // Live read-only debug values (auto-refresh via .listen())
    const dbg = f.addFolder('Debug values');
    dbg.add(this, 'dbgLeftGroundY').name('L ground Y').listen();
    dbg.add(this, 'dbgLeftFootWorldY').name('L foot world Y').listen();
    dbg.add(this, 'dbgLeftRaw').name('L raw offset').listen();
    dbg.add(this, 'dbgLeftOffset').name('L smoothed offset').listen();
    dbg.add(this, 'dbgRightGroundY').name('R ground Y').listen();
    dbg.add(this, 'dbgRightFootWorldY').name('R foot world Y').listen();
    dbg.add(this, 'dbgRightRaw').name('R raw offset').listen();
    dbg.add(this, 'dbgRightOffset').name('R smoothed offset').listen();
    dbg.add(this, 'dbgPelvisOffset').name('Pelvis offset').listen();
  }

  public renderDebug(): void {}
}
