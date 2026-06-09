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

  /**
   * How far ABOVE the animated foot the raycast starts (default 0.05 m).
   * Handles the case where the animation places the foot slightly inside the ground.
   */
  raycastUpOffset?: number;

  /**
   * How far BELOW the animated foot the raycast searches for ground (default 0.15 m).
   * This is the primary control for swing-phase filtering: a foot 0.3 m in the air
   * won't be hit by a 0.15 m ray, so IK is automatically skipped. No threshold
   * parameter needed — the ray length IS the filter.
   */
  raycastMaxDown?: number;

  /** Exponential-decay speed for the per-foot Y offset (default 12). */
  footLerpSpeed?: number;

  /** IK influence weight 0–1 (default 1). */
  ikWeight?: number;
}

/**
 * FootIKComponent — places feet on the ground using Two-Bone IK.
 *
 * Design:
 *   - Raycasts are ALWAYS fired from the animated foot position.
 *   - A short `raycastMaxDown` (~0.15 m) acts as the swing-phase filter naturally:
 *     a foot high in the air during a stride or stair-climb won't hit ground within
 *     that distance → no IK applied. No artificial height threshold needed.
 *   - Tracks a scalar Y offset per foot (not a world-space position) so the IK
 *     target is always: animatedModelPos + [0, smoothedYOffset, 0]. XZ stays
 *     locked to the animation — only Y is corrected. This avoids the world-space
 *     drift bug where moving characters' feet trail behind.
 *   - Constraints start at weight=0 and activate on the first frame with valid data.
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

  private raycastUpOffset: number = 0.05;
  private raycastMaxDown: number = 0.15;
  private footLerpSpeed: number = 12;
  private ikWeight: number = 1.0;

  // ── Runtime ──────────────────────────────────────────────────────────────────
  private animator: AnimatorComponent | null = null;
  private leftConstraint: TwoBoneIkConstraint | null = null;
  private rightConstraint: TwoBoneIkConstraint | null = null;

  // Per-foot smoothed Y correction (model space, positive = lift foot up).
  private leftYOffset: number = 0;
  private rightYOffset: number = 0;

  // Prevents activating IK before the first valid joint position is available.
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
      mat4.create(),
      worldRot,
      worldPos,
      vec3.fromValues(1, 1, 1),
    );

    // Exclude the character capsule from foot raycasts.
    const parent = this.getOwner().getParent();
    const capsuleBody: RAPIER.RigidBody | undefined =
      (parent?.getComponent('capsule_collider') as any)?.getRigidBody?.() ?? undefined;

    const leftFootIdx = this.animator.getJointIndex(this.leftFoot);
    const rightFootIdx = this.animator.getJointIndex(this.rightFoot);

    // Use the previous frame's globalMats (FootIK runs before animator).
    const leftAnimWorld = this.getJointWorldPos(leftFootIdx, worldMat);
    const rightAnimWorld = this.getJointWorldPos(rightFootIdx, worldMat);
    const leftAnimModel = this.getJointModelPos(leftFootIdx);
    const rightAnimModel = this.getJointModelPos(rightFootIdx);

    if (!leftAnimWorld || !rightAnimWorld || !leftAnimModel || !rightAnimModel) return;

    // Enable constraints on the first frame with valid joint data.
    if (!this.initialized) {
      //this.leftConstraint!.weight = this.ikWeight;
      //this.rightConstraint!.weight = this.ikWeight;
      this.initialized = true;
    }

    const alpha = Math.min(1.0, dt * this.footLerpSpeed);

    // ── Left foot ─────────────────────────────────────────────────────────────
    {
      const groundY = this.castGroundY(leftAnimWorld, capsuleBody);
      const rawOffset = groundY !== null ? groundY - leftAnimWorld[1] : 0;
      this.leftYOffset += (rawOffset - this.leftYOffset) * alpha;
    }

    // ── Right foot ────────────────────────────────────────────────────────────
    {
      const groundY = this.castGroundY(rightAnimWorld, capsuleBody);
      const rawOffset = groundY !== null ? groundY - rightAnimWorld[1] : 0;
      this.rightYOffset += (rawOffset - this.rightYOffset) * alpha;
    }

    // ── Write IK targets ──────────────────────────────────────────────────────
    // Target = animated model-space position + Y-only correction.
    // XZ is locked to the animation so feet never drift horizontally.
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

    // weight=0 until the first valid frame to avoid feet snapping to origin.
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

  /**
   * Raycasts downward from slightly above the animated foot position.
   * Returns the ground Y in world space, or null if nothing is hit within range.
   * The total ray length is raycastUpOffset + raycastMaxDown — typically ~0.2 m,
   * which naturally excludes feet that are high in the air (swing/stair-climb phase).
   */
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
