import { vec3, mat4, quat } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { AnimatorComponent, TwoBoneIkConstraint } from './AnimatorComponent';
import { Engine } from '../../core/engine/Engine';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

export interface FootIKData {
  /** Joint names — defaults match Mixamo skeleton. Override for other skeletons. */
  leftThigh?: string;
  leftKnee?: string;
  leftFoot?: string;
  rightThigh?: string;
  rightKnee?: string;
  rightFoot?: string;

  /** How far above the animated foot position the raycast starts (default 0.5 m). */
  raycastUpOffset?: number;
  /** Max distance the ray travels downward from the start offset (default 1.0 m). */
  raycastMaxDown?: number;

  /**
   * Exponential-decay speed for the per-foot Y offset (default 12).
   * Higher = foot snaps to ground faster but may look rigid.
   */
  footLerpSpeed?: number;

  /**
   * How high the foot must be above the mesh entity's world Y before it is
   * considered "in swing phase" and IK is skipped (default 0.12 m).
   * Prevents the IK from pinning the foot to the ground during the lift phase of a stride.
   */
  swingThreshold?: number;

  /** Maximum Y correction the IK may apply in either direction (default 0.4 m). */
  maxStepCorrection?: number;

  /** IK influence weight 0–1 (default 1). */
  ikWeight?: number;
}

/**
 * FootIKComponent — places feet on the ground using Two-Bone IK.
 *
 * Key design decisions:
 *
 *   1. Runs BEFORE 'animator' in components.json so targets are ready for
 *      AnimatorComponent.evaluateAnimation().
 *
 *   2. Reads the PREVIOUS frame's globalMats (acceptable 1-frame lag for IK targets).
 *
 *   3. Tracks only a per-foot Y OFFSET (scalar, model space) rather than a full
 *      world-space target. This avoids the world-space drift bug: when the character
 *      moves, the XZ of the target must follow the animation exactly; only the Y
 *      needs smoothing for terrain height changes.
 *
 *   4. Swing-phase detection: if the animated foot is more than `swingThreshold`
 *      metres above the mesh entity's world Y (≈ ground level), the IK is skipped
 *      and the offset decays back to 0. This prevents the IK from pulling the foot
 *      to the ground during the airborne phase of a stride cycle.
 *
 *   5. IK constraints start with weight=0 and are enabled on the first frame that
 *      valid joint data is available, preventing the "feet snap to origin" glitch.
 *
 * Limitations / future work:
 *   - Pelvis adjustment: requires a pre-IK local-matrix pass in AnimatorComponent.
 *   - Foot rotation to match surface normal: needs deferred GPU upload.
 */
export class FootIKComponent extends Component {
  // ── Config ───────────────────────────────────────────────────────────────────
  private leftThigh: string = 'mixamorig:LeftUpLeg';
  private leftKnee: string = 'mixamorig:LeftLeg';
  private leftFoot: string = 'mixamorig:LeftFoot';
  private rightThigh: string = 'mixamorig:RightUpLeg';
  private rightKnee: string = 'mixamorig:RightLeg';
  private rightFoot: string = 'mixamorig:RightFoot';

  private raycastUpOffset: number = 0.5;
  private raycastMaxDown: number = 1.0;
  private footLerpSpeed: number = 12;
  private swingThreshold: number = 0.12;
  private maxStepCorrection: number = 0.4;
  private ikWeight: number = 1.0;

  // ── Runtime ──────────────────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private leftConstraint: TwoBoneIkConstraint | null = null;
  private rightConstraint: TwoBoneIkConstraint | null = null;

  // Per-foot smoothed Y offsets (model space, positive = lift foot up).
  private leftYOffset: number = 0;
  private rightYOffset: number = 0;

  // Prevents IK from activating until the first valid joint position is available.
  private initialized: boolean = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  public async load(data: FootIKData): Promise<void> {
    if (data.leftThigh) this.leftThigh = data.leftThigh;
    if (data.leftKnee) this.leftKnee = data.leftKnee;
    if (data.leftFoot) this.leftFoot = data.leftFoot;
    if (data.rightThigh) this.rightThigh = data.rightThigh;
    if (data.rightKnee) this.rightKnee = data.rightKnee;
    if (data.rightFoot) this.rightFoot = data.rightFoot;
    if (data.raycastUpOffset !== undefined) this.raycastUpOffset = data.raycastUpOffset;
    if (data.raycastMaxDown !== undefined) this.raycastMaxDown = data.raycastMaxDown;
    if (data.footLerpSpeed !== undefined) this.footLerpSpeed = data.footLerpSpeed;
    if (data.swingThreshold !== undefined) this.swingThreshold = data.swingThreshold;
    if (data.maxStepCorrection !== undefined) this.maxStepCorrection = data.maxStepCorrection;
    if (data.ikWeight !== undefined) this.ikWeight = data.ikWeight;
  }

  public override async onAttach(): Promise<void> {
    this.animator = this.getOwner().getComponent('animator') as AnimatorComponent | null;
  }

  public update(dt: number): void {
    if (!this.animator) return;

    // Lazy-create constraints — skeleton may not be loaded during onAttach.
    if (!this.leftConstraint && !this.tryCreateConstraints()) return;

    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return;

    const worldPos = transform.getTransform().getWorldPosition();
    const worldRot = transform.getTransform().getWorldRotation() as quat;
    const worldMat = mat4.fromRotationTranslationScale(
      mat4.create(), worldRot, worldPos, vec3.fromValues(1, 1, 1),
    );

    // Exclude the character capsule from foot raycasts.
    const parent = this.getOwner().getParent();
    const capsuleBody: RAPIER.RigidBody | undefined =
      (parent?.getComponent('capsule_collider') as any)?.getRigidBody?.() ?? undefined;

    // The mesh entity's world Y approximates the character's ground level
    // (parent capsule center at +0.9, mesh child at -0.9 → world ≈ 0 when standing).
    const meshWorldY = worldPos[1];

    const leftFootIdx = this.animator.getJointIndex(this.leftFoot);
    const rightFootIdx = this.animator.getJointIndex(this.rightFoot);

    // Previous frame's animated foot positions.
    const leftAnimWorld = this.getJointWorldPos(leftFootIdx, worldMat);
    const rightAnimWorld = this.getJointWorldPos(rightFootIdx, worldMat);
    const leftAnimModel = this.getJointModelPos(leftFootIdx);
    const rightAnimModel = this.getJointModelPos(rightFootIdx);

    if (!leftAnimWorld || !rightAnimWorld || !leftAnimModel || !rightAnimModel) return;

    // Enable constraints on the first frame with valid data.
    if (!this.initialized) {
      this.leftConstraint!.weight = this.ikWeight;
      this.rightConstraint!.weight = this.ikWeight;
      this.initialized = true;
    }

    const alpha = Math.min(1.0, dt * this.footLerpSpeed);

    // ── Left foot ─────────────────────────────────────────────────────────────
    // Skip IK when foot is lifted high enough to be in swing phase.
    {
      const footAbove = leftAnimWorld[1] - meshWorldY;
      let rawOffset = 0;
      if (footAbove <= this.swingThreshold) {
        const groundY = this.castGroundY(leftAnimWorld, capsuleBody);
        if (groundY !== null) {
          rawOffset = groundY - leftAnimWorld[1];
          rawOffset = Math.max(-this.maxStepCorrection, Math.min(this.maxStepCorrection, rawOffset));
        }
      }
      // Smooth toward raw offset. When swing phase (rawOffset=0), decays back to neutral.
      this.leftYOffset += (rawOffset - this.leftYOffset) * alpha;
    }

    // ── Right foot ────────────────────────────────────────────────────────────
    {
      const footAbove = rightAnimWorld[1] - meshWorldY;
      let rawOffset = 0;
      if (footAbove <= this.swingThreshold) {
        const groundY = this.castGroundY(rightAnimWorld, capsuleBody);
        if (groundY !== null) {
          rawOffset = groundY - rightAnimWorld[1];
          rawOffset = Math.max(-this.maxStepCorrection, Math.min(this.maxStepCorrection, rawOffset));
        }
      }
      this.rightYOffset += (rawOffset - this.rightYOffset) * alpha;
    }

    // ── Write IK targets ──────────────────────────────────────────────────────
    // Target = animated model-space position + Y correction only.
    // X and Z always match the animation — no horizontal IK drift.
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
    // Joint index < 0 means skeleton not yet loaded.
    if (this.animator.getJointIndex(this.leftThigh) < 0) return false;

    // Start with weight=0 to avoid the "feet snap to origin" glitch on frame 0.
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

  /** World-space position of a joint using the PREVIOUS frame's globalMats. */
  private getJointWorldPos(jointIdx: number, worldMat: mat4): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointModelMatrix(jointIdx);
    if (!M) return null;
    const combined = mat4.mul(mat4.create(), worldMat, M as mat4);
    return vec3.fromValues(combined[12]!, combined[13]!, combined[14]!);
  }

  /** Model-space position of a joint (column 3 of globalMats). */
  private getJointModelPos(jointIdx: number): vec3 | null {
    if (jointIdx < 0) return null;
    const M = this.animator!.getJointModelMatrix(jointIdx);
    if (!M) return null;
    return vec3.fromValues(M[12]!, M[13]!, M[14]!);
  }

  /** Raycasts downward from above the foot and returns the ground Y, or null if no hit. */
  private castGroundY(footWorld: vec3, excludeBody?: RAPIER.RigidBody): number | null {
    const physics = Engine.getPhysics();
    if (!physics) return null;

    const originY = footWorld[1] + this.raycastUpOffset;
    const ray = new RAPIER.Ray(
      { x: footWorld[0], y: originY, z: footWorld[2] },
      { x: 0, y: -1, z: 0 },
    );
    const hit = physics.getWorld().castRay(
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
