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
  /** How far below the animated foot the raycast searches (default 0.8 m). */
  raycastMaxDown?: number;
  /**
   * How far above the capsule bottom the foot must be (in addition to ankleHeight)
   * before the foot is treated as "in swing" and IK is skipped (default 0.22 m).
   * Using capsule-relative height keeps the filter calibrated on slopes — on a
   * downward ramp the capsule descends with the character so the threshold adjusts
   * automatically. Falls back to a fixed ground-contact threshold when no capsule
   * is found.
   */
  swingLiftThreshold?: number;

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
  private raycastMaxDown: number = 0.8;
  private swingLiftThreshold: number = 0.22;
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
  private currentIkWeight: number = 0;

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
    if (data.swingLiftThreshold !== undefined) this.swingLiftThreshold = data.swingLiftThreshold;
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

    // ── Grounded state ────────────────────────────────────────────────────────
    const controllerEntity = this.getOwner().getParent() ?? this.getOwner();
    const controller =
      (controllerEntity.getComponent('player_controller') as any) ??
      (this.getOwner().getComponent('player_controller') as any);
    const isGrounded = !controller || controller.getIsGrounded?.() !== false;

    // ── IK weight: fade to 0 in the air so animation drives legs fully ────────
    // Fade out fast (15/s) to avoid stretched legs on jump; fade in medium (8/s).
    const targetWeight = isGrounded ? this.ikWeight : 0;
    this.currentIkWeight +=
      (targetWeight - this.currentIkWeight) * Math.min(1, dt * (isGrounded ? 8 : 15));
    this.leftConstraint!.weight = this.currentIkWeight;
    this.rightConstraint!.weight = this.currentIkWeight;

    const worldMat = transform.getTransform().getWorldMatrix() as mat4;
    const parent = this.getOwner().getParent();
    const capsuleBody: RAPIER.RigidBody | undefined =
      (parent?.getComponent('capsule_collider') as any)?.getRigidBody?.() ?? undefined;

    const leftFootIdx = this.animator.getJointIndex(this.leftFoot);
    const rightFootIdx = this.animator.getJointIndex(this.rightFoot);
    const leftBaseWorld = this.getJointBaseAnimWorldPos(leftFootIdx, worldMat);
    const rightBaseWorld = this.getJointBaseAnimWorldPos(rightFootIdx, worldMat);
    const leftAnimModel = this.getJointBaseAnimModelPos(leftFootIdx);
    const rightAnimModel = this.getJointBaseAnimModelPos(rightFootIdx);
    if (!leftBaseWorld || !rightBaseWorld || !leftAnimModel || !rightAnimModel) return;

    const footAlpha = Math.min(1.0, dt * this.footLerpSpeed);
    const pelvisAlpha = Math.min(1.0, dt * this.pelvisLerpSpeed);

    // Skip raycasts when airborne — offsets will lerp toward 0 on their own.
    const leftGroundY = isGrounded ? this.castGroundY(leftBaseWorld, capsuleBody) : null;
    const rightGroundY = isGrounded ? this.castGroundY(rightBaseWorld, capsuleBody) : null;

    // ── Swing-phase filter ────────────────────────────────────────────────────
    // Determine whether each foot is planted or in swing so we don't pull it
    // down while the animation lifts it.
    //
    // Capsule-relative mode (preferred): the foot is in swing when it is more
    // than (swingLiftThreshold + ankleHeight) above the capsule bottom.  Because
    // the capsule follows the character down a slope, this threshold self-adjusts
    // on ramps — a foot resting on a steep downward slope is still only ~ankleHeight
    // above the capsule bottom and will correctly receive IK.
    //
    // Fallback (no capsule): fixed threshold above the raycast hit point.
    const capsuleComp = parent?.getComponent('capsule_collider') as any;
    const capsuleBottomY: number | null =
      capsuleBody && capsuleComp?.getCapsuleHeight
        ? (capsuleBody.translation().y as number) - (capsuleComp.getCapsuleHeight() as number) / 2
        : null;

    const swingCutoff = this.swingLiftThreshold + this.ankleHeight;

    const isLeftSwing =
      leftGroundY === null ||
      (capsuleBottomY !== null
        ? leftBaseWorld[1] - capsuleBottomY > swingCutoff
        : leftBaseWorld[1] - (leftGroundY + this.ankleHeight) > this.swingLiftThreshold);

    const isRightSwing =
      rightGroundY === null ||
      (capsuleBottomY !== null
        ? rightBaseWorld[1] - capsuleBottomY > swingCutoff
        : rightBaseWorld[1] - (rightGroundY + this.ankleHeight) > this.swingLiftThreshold);

    const leftRaw = isLeftSwing ? 0 : leftGroundY! + this.ankleHeight - leftBaseWorld[1];
    const rightRaw = isRightSwing ? 0 : rightGroundY! + this.ankleHeight - rightBaseWorld[1];

    this.leftYOffset += (leftRaw - this.leftYOffset) * footAlpha;
    this.rightYOffset += (rightRaw - this.rightYOffset) * footAlpha;

    // ── Pelvis adjustment ─────────────────────────────────────────────────────
    const worldScaleY = (transform.getTransform().getWorldScale() as vec3)[1];
    const invScaleY = worldScaleY > 0 ? 1.0 / worldScaleY : 1.0;

    const pelvisTarget = Math.min(this.leftYOffset, this.rightYOffset, 0);
    // Rise at 25 % of drop speed — prevents the pelvis from bobbing each stride
    // cycle as feet alternate between planted and swing.
    const pelvisAlphaEffective =
      pelvisTarget > this.pelvisYOffset
        ? Math.min(1.0, dt * this.pelvisLerpSpeed * 0.25)
        : pelvisAlpha;
    this.pelvisYOffset += (pelvisTarget - this.pelvisYOffset) * pelvisAlphaEffective;

    this.animator.setPreIkBoneOffset(
      this.pelvis,
      vec3.fromValues(0, this.pelvisYOffset * invScaleY, 0),
    );

    // ── IK targets in model space ─────────────────────────────────────────────
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
          ` | pelvis=${this.pelvisYOffset.toFixed(3)} weight=${this.currentIkWeight.toFixed(3)}`,
      );
    }
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
    f.add(this, 'swingLiftThreshold', 0.05, 0.6, 0.01).name('Swing lift (m)');
    f.add(this, 'footLerpSpeed', 1, 30, 1).name('Foot smooth');
    f.add(this, 'pelvisLerpSpeed', 1, 20, 1).name('Pelvis smooth');
    f.add(this, 'raycastMaxDown', 0.05, 2.0, 0.01).name('Ray max down (m)');
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
