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
      quat.fromEuler(rotOff, data.rotationOffset[0], data.rotationOffset[1], data.rotationOffset[2]);
    }

    mat4.fromRotationTranslation(this.offsetMat, rotOff, posOff);
  }

  public update(_dt: number): void {
    this.resolve();
    if (!this.animator || this.jointIndex < 0) return;

    const jointModelMat = this.animator.getJointModelMatrix(this.jointIndex);
    if (!jointModelMat) return;

    // The sword is a child of the mesh entity, so mesh-local space == local space.
    // globalMats[i] is already in mesh-local space — use it directly as local transform.
    const finalMat = mat4.mul(mat4.create(), jointModelMat as mat4, this.offsetMat);

    const myTc = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!myTc) return;

    const pos = vec3.create();
    const rot = quat.create();
    mat4.getTranslation(pos, finalMat);
    mat4.getRotation(rot, finalMat);
    quat.normalize(rot, rot);

    // Set LOCAL transform — TransformComponent (which runs after this) will
    // compute and upload the correct world matrix to the GPU.
    myTc.getTransform().setLocalPosition(pos);
    myTc.getTransform().setLocalRotation(rot);
  }

  private resolve(): void {
    if (this.resolved) return;
    const parent = this.getOwner().getParent();
    if (!parent) return;
    const anim = parent.getComponent('animator') as AnimatorComponent | null;
    if (!anim) return;
    this.animator = anim;
    this.jointIndex = anim.getJointIndex(this.boneName);
    if (this.jointIndex < 0) {
      console.warn(`[BoneAttachment] Bone "${this.boneName}" not found. Available:\n${anim.getAllJointNames().join(', ')}`);
    } else {
      console.log(`[BoneAttachment] All bones:\n${anim.getAllJointNames().join('\n')}`);
    }
    this.resolved = true;
  }

  public renderDebug(): void {}
}
