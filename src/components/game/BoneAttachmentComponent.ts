import { mat4, quat, vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { AnimatorComponent } from '../render/AnimatorComponent';

export interface BoneAttachmentData {
  boneName: string;
  positionOffset?: [number, number, number];
  /** Euler angles in degrees [pitch, yaw, roll] */
  rotationOffset?: [number, number, number];
}

/**
 * BoneAttachmentComponent — snaps this entity's LOCAL transform to a bone on
 * the parent entity's AnimatorComponent every frame.
 *
 * Must run BEFORE 'transform' in components.json so that TransformComponent
 * can compute the correct world matrix and upload it to the GPU in the same frame.
 *
 * Expects: parent entity has 'animator'. This entity must be a direct child of
 * the entity with the AnimatorComponent so that mesh-local coords == local coords.
 *
 * Component key: 'bone_attachment'
 */
export class BoneAttachmentComponent extends Component {
  private boneName: string = 'hand_r';
  private offsetMat: mat4 = mat4.identity(mat4.create());

  private animator: AnimatorComponent | null = null;
  private jointIndex: number = -1;
  private resolved: boolean = false;

  public load(data: BoneAttachmentData): void {
    this.boneName = data.boneName ?? 'hand_r';

    const posOff: vec3 = data.positionOffset
      ? vec3.fromValues(data.positionOffset[0], data.positionOffset[1], data.positionOffset[2])
      : vec3.create();

    const rotOff: quat = quat.create();
    if (data.rotationOffset) {
      quat.fromEuler(
        rotOff,
        data.rotationOffset[0],
        data.rotationOffset[1],
        data.rotationOffset[2],
      );
    }

    mat4.fromRotationTranslation(this.offsetMat, rotOff, posOff);
  }

  public update(_dt: number): void {
    // Normal path: the animator calls syncToBone() right after evaluating its pose (see
    // resolve()); polling here would read the previous frame's pose.
    this.resolve();
  }

  private readonly syncToBone = (): void => {
    if (!this.animator || this.jointIndex < 0) return;
    const jointModelMat = this.animator.getJointModelMatrix(this.jointIndex);
    if (!jointModelMat) return;
    const myTc = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!myTc) return;

    // This entity is a child of the mesh entity, so mesh-local space == local space.
    // globalMats[i] is already in mesh-local space — use it directly as local transform.
    const finalMat = mat4.mul(this._mat, jointModelMat as mat4, this.offsetMat);
    mat4.getTranslation(this._pos, finalMat);
    mat4.getRotation(this._rot, finalMat);
    quat.normalize(this._rot, this._rot);
    myTc.getTransform().setLocalPosition(this._pos);
    myTc.getTransform().setLocalRotation(this._rot);
    // 'transform' already ran this frame: recompute world + GPU matrix (and children) now.
    myTc.update();
  };
  private readonly _mat = mat4.create();
  private readonly _pos = vec3.create();
  private readonly _rot = quat.create();

  private resolve(): void {
    if (this.resolved) return;
    const parent = this.getOwner().getParent();
    if (!parent) return;
    const anim = parent.getComponent('animator') as AnimatorComponent | null;
    if (!anim) return;
    this.animator = anim;
    this.jointIndex = anim.getJointIndex(this.boneName);
    if (this.jointIndex < 0) {
      console.warn(
        `[BoneAttachment] Bone "${this.boneName}" not found. Available:\n${anim.getAllJointNames().join(', ')}`,
      );
    } else {
      console.log(`[BoneAttachment] All bones:\n${anim.getAllJointNames().join('\n')}`);
    }
    this.resolved = true;
    anim.addPoseListener(this.syncToBone);
  }

  public override dispose(): void {
    this.animator?.removePoseListener(this.syncToBone);
  }

  public renderDebug(): void {}
}
