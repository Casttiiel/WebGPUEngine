/**
 * Skinning vertex data extracted from a GLTF primitive.
 * joints: Uint8Array of 4 joint indices per vertex (JOINTS_0).
 * weights: Float32Array of 4 blend weights per vertex (WEIGHTS_0).
 */
export interface SkinningVertexData {
  joints: Uint8Array; // length = vertexCount * 4
  weights: Float32Array; // length = vertexCount * 4
}

/**
 * Skeleton definition extracted from a GLTF skin.
 * - inverseBindMatrices: flat column-major mat4 array (length = jointCount * 16)
 * - joints: GLTF node indices for each joint (length = jointCount)
 * - parents: parent joint index per joint (-1 = root)
 * - names: human-readable bone names for debugging
 */
export interface SkeletonData {
  inverseBindMatrices: Float32Array; // [jointCount * 16]
  joints: number[]; // GLTF node indices
  parents: number[]; // joint-space parent index per joint
  names: string[]; // bone names
  /** Local TRS for each joint in bind pose (translation x3, rotation x4, scale x3) */
  bindPoseLocal: Float32Array; // [jointCount * 10]  (t3 + r4 + s3)
}

/** Keyframe interpolation mode (matches GLTF spec). */
export type AnimationInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

/** A single animated property channel for one joint. */
export interface AnimationChannel {
  /** Index into SkeletonData.joints array. */
  jointIndex: number;
  path: 'translation' | 'rotation' | 'scale';
  times: Float32Array;
  /**
   * Flat value array.
   * - translation/scale: xyz per keyframe (length = keyframes * 3)
   * - rotation:          xyzw per keyframe (length = keyframes * 4)
   * - CUBICSPLINE:       3× the above (in-tangent, value, out-tangent per keyframe)
   */
  values: Float32Array;
  interpolation: AnimationInterpolation;
}

/** A complete animation clip extracted from a GLTF animation. */
export interface AnimationClip {
  name: string;
  duration: number; // seconds
  channels: AnimationChannel[];
}
