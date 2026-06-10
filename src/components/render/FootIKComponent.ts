import { vec3, mat4, quat } from 'gl-matrix';
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

  /** How far above the animated foot the raycast starts (default 0.05 m). */
  raycastUpOffset?: number;
  /** How far below the animated foot the raycast searches (default 0.3 m). */
  raycastMaxDown?: number;

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

  private raycastUpOffset: number = 0.05;
  private raycastMaxDown: number = 0.3;
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

  private leftNaturalHeight: number | null = null;
  private rightNaturalHeight: number | null = null;
  private initialized: boolean = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  public async load(data: FootIKData): Promise<void> {
    if (data.leftThigh) this.leftThigh = data.leftThigh;
    if (data.leftKnee) this.leftKnee = data.leftKnee;
    if (data.leftFoot) this.leftFoot = data.leftFoot;
    if (data.rightThigh) this.rightThigh = data.rightThigh;
    if (data.rightKnee) this.rightKnee = data.rightKnee;
    if (data.rightFoot) this.rightFoot = data.rightFoot;
    if (data.pelvis) this.pelvis = data.pelvis;
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

    const worldPos = transform.getTransform().getWorldPosition();
    const worldRot = transform.getTransform().getWorldRotation() as quat;
    const worldMat = mat4.fromRotationTranslationScale(
      mat4.create(),
      worldRot,
      worldPos,
      vec3.fromValues(1, 1, 1),
    );

    const parent = this.getOwner().getParent();
    const capsuleBody: RAPIER.RigidBody | undefined =
      (parent?.getComponent('capsule_collider') as any)?.getRigidBody?.() ?? undefined;

    const leftFootIdx = this.animator.getJointIndex(this.leftFoot);
    const rightFootIdx = this.animator.getJointIndex(this.rightFoot);

    const leftAnimWorld = this.getJointWorldPos(leftFootIdx, worldMat);
    const rightAnimWorld = this.getJointWorldPos(rightFootIdx, worldMat);
    const leftAnimModel = this.getJointModelPos(leftFootIdx);
    const rightAnimModel = this.getJointModelPos(rightFootIdx);

    if (!leftAnimWorld || !rightAnimWorld || !leftAnimModel || !rightAnimModel) return;

    // Activate constraints on first valid frame and sample natural ankle heights.
    if (!this.initialized) {
      const leftGroundY = this.castGroundY(leftAnimWorld, capsuleBody);
      const rightGroundY = this.castGroundY(rightAnimWorld, capsuleBody);
      this.leftNaturalHeight = leftGroundY !== null ? leftAnimWorld[1] - leftGroundY : 0;
      this.rightNaturalHeight = rightGroundY !== null ? rightAnimWorld[1] - rightGroundY : 0;
      this.leftConstraint!.weight = this.ikWeight;
      this.rightConstraint!.weight = this.ikWeight;
      this.initialized = true;
    }

    const footAlpha = Math.min(1.0, dt * this.footLerpSpeed);
    const pelvisAlpha = Math.min(1.0, dt * this.pelvisLerpSpeed);

    // ── Left foot ─────────────────────────────────────────────────────────────
    {
      const groundY = this.castGroundY(leftAnimWorld, capsuleBody);
      const rawOffset =
        groundY !== null ? groundY + this.leftNaturalHeight! - leftAnimWorld[1] : 0;
      this.leftYOffset += (rawOffset - this.leftYOffset) * footAlpha;
    }

    // ── Right foot ────────────────────────────────────────────────────────────
    {
      const groundY = this.castGroundY(rightAnimWorld, capsuleBody);
      const rawOffset =
        groundY !== null ? groundY + this.rightNaturalHeight! - rightAnimWorld[1] : 0;
      this.rightYOffset += (rawOffset - this.rightYOffset) * footAlpha;
    }

    // ── Pelvis adjustment ─────────────────────────────────────────────────────
    // Drop pelvis by the lowest foot correction so both knees can bend naturally.
    // Never lift the pelvis (min with 0) — only compensate downward.
    const targetPelvisOffset = Math.min(this.leftYOffset, this.rightYOffset, 0);
    this.pelvisYOffset += (targetPelvisOffset - this.pelvisYOffset) * pelvisAlpha;

    if (Math.abs(this.pelvisYOffset) > 0.0001) {
      this.animator.setPreIkBoneOffset(this.pelvis, vec3.fromValues(0, this.pelvisYOffset, 0));
    }

    // ── Write IK targets ──────────────────────────────────────────────────────
    // Targets are in model space. Y correction is absolute (relative to world ground),
    // so the TwoBoneIK bends the knee from the new pelvis-adjusted leg position.
    vec3.set(
      this.leftConstraint!.target,
      leftAnimModel[0]!,
      leftAnimModel[1]! + this.leftYOffset,
      leftAnimModel[2]!,
    );
    vec3.set(
      this.rightConstraint!.target,
      rightAnimModel[0]!,
      rightAnimModel[1]! + this.rightYOffset,
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

  private getJointWorldPos(jointIdx: number, worldMat: mat4): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointModelMatrix(jointIdx);
    if (!M) return null;
    const combined = mat4.mul(mat4.create(), worldMat, M as mat4);
    return vec3.fromValues(combined[12]!, combined[13]!, combined[14]!);
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

  public override renderInMenu(): void {}
  public renderDebug(): void {}
}
