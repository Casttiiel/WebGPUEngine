import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { SkinnedMeshAsset } from '../../renderer/resources/SkinnedMeshAsset';
import { RenderManagerV2 } from '../../renderer/core/managers/RenderManagerV2';
import { TextureStreamingManager } from '../../renderer/core/managers/TextureStreamingManager';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { vec3 } from 'gl-matrix';

export interface SkeletalMeshComponentData {
  gltf: string;
}

const MAX_JOINTS = 128;
const MAT4_BYTES = 64;

/**
 * SkeletalMeshComponent — pure render component for a skinned character.
 *
 * Responsibilities:
 *   - Loads SkinnedMeshAsset (shared GPU vertex buffers + material)
 *   - Creates per-instance joint-matrix GPU buffers
 *   - Registers render keys (including shadow key, via casts_shadows on the material)
 *   - Registers material textures with TextureStreamingManager
 *   - Exposes uploadPose() so AnimatorComponent can drive the skeleton each frame
 *
 * Animation logic lives entirely in AnimatorComponent.
 */
export class SkeletalMeshComponent extends Component {
  public asset!: SkinnedMeshAsset;

  private jointMatrixBuffer!: GPUBuffer;
  private previousJointMatrixBuffer!: GPUBuffer;
  private skinBindGroup!: GPUBindGroup;
  private previousSkinBindGroup!: GPUBindGroup;
  private velocitySkinPairBindGroup!: GPUBindGroup;

  // Staging copy for previous-frame detection (avoids zero-velocity ghost on spawn).
  private previousJointPalette: Float32Array = new Float32Array(MAX_JOINTS * 16);

  private streamingPosGetter: (() => vec3) | null = null;

  public async load(data: SkeletalMeshComponentData): Promise<void> {
    const { gltf } = data;
    this.asset = await SkinnedMeshAsset.get(gltf);

    const device = GPUUtils.getDevice();
    const bgl = BindGroupFactory.getSkinMatricesLayout();

    this.jointMatrixBuffer = device.createBuffer({
      label: `${gltf}_joints`,
      size: MAX_JOINTS * MAT4_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.skinBindGroup = device.createBindGroup({
      label: `${gltf}_skinBG`,
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.jointMatrixBuffer } }],
    });

    this.previousJointMatrixBuffer = device.createBuffer({
      label: `${gltf}_prevJoints`,
      size: MAX_JOINTS * MAT4_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.previousSkinBindGroup = device.createBindGroup({
      label: `${gltf}_prevSkinBG`,
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.previousJointMatrixBuffer } }],
    });

    this.velocitySkinPairBindGroup = device.createBindGroup({
      label: `${gltf}_velSkinPairBG`,
      layout: BindGroupFactory.getSkinMatricesPairLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.jointMatrixBuffer } },
        { binding: 1, resource: { buffer: this.previousJointMatrixBuffer } },
      ],
    });

    // Upload identity matrices as the default (bind) pose so the mesh is visible
    // even without an AnimatorComponent. Clamped to MAX_JOINTS.
    const defaultPalette = new Float32Array(MAX_JOINTS * 16);
    const defaultJointCount = Math.min(this.asset.skeleton.joints.length, MAX_JOINTS);
    for (let i = 0; i < defaultJointCount; i++) {
      const o = i * 16;
      defaultPalette[o] = 1; defaultPalette[o + 5] = 1;
      defaultPalette[o + 10] = 1; defaultPalette[o + 15] = 1;
    }
    device.queue.writeBuffer(this.jointMatrixBuffer, 0, defaultPalette);
    device.queue.writeBuffer(this.previousJointMatrixBuffer, 0, defaultPalette);
    this.previousJointPalette.set(defaultPalette);

    // Register render keys — shadow key is auto-created by RenderManagerV2
    // because the material now has casts_shadows: true.
    const renderManager = RenderManagerV2.getInstance();
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    for (const sm of this.asset.skinnedMeshes) {
      renderManager.addKey(this as any, sm as any, this.asset.material, transform, false, 1, undefined, this.skinBindGroup);
    }

    // Register textures with TextureStreamingManager so MIP levels are upgraded
    // when this character comes within range of the camera.
    const tc = this.getOwner().getComponent('transform') as TransformComponent | undefined;
    if (tc) {
      this.streamingPosGetter = () => tc.getTransform().getWorldPosition();
      const tsm = TextureStreamingManager.getInstance();
      for (const tex of this.asset.material.getAssetTextures()) {
        tsm.register(tex, this.streamingPosGetter);
      }
    }
  }

  /**
   * Upload a joint palette (flattened mat4 array, MAX_JOINTS * 16 floats) to the GPU.
   * Called every frame by AnimatorComponent after pose evaluation.
   */
  public uploadPose(palette: Float32Array): void {
    const device = GPUUtils.getDevice();
    const jointCount = Math.min(this.asset.skeleton.joints.length, MAX_JOINTS);
    const floatCount = jointCount * 16;

    // On the first frame, prime the previous palette with the current pose so
    // the velocity pass doesn't produce a ghost flash on spawn.
    if (this.previousJointPalette.every((v) => v === 0)) {
      this.previousJointPalette.set(palette.subarray(0, floatCount));
    }

    device.queue.writeBuffer(this.previousJointMatrixBuffer, 0, this.previousJointPalette, 0, floatCount);
    this.previousJointPalette.set(palette.subarray(0, floatCount));
    device.queue.writeBuffer(this.jointMatrixBuffer, 0, palette, 0, floatCount);
  }

  public update(_dt: number): void {}

  public override dispose(): void {
    RenderManagerV2.getInstance().delKeys(this as any);
    this.jointMatrixBuffer?.destroy();
    this.previousJointMatrixBuffer?.destroy();

    if (this.streamingPosGetter) {
      const tsm = TextureStreamingManager.getInstance();
      for (const tex of this.asset.material.getAssetTextures()) {
        tsm.unregister(tex, this.streamingPosGetter);
      }
    }
  }

  public getSkinBindGroup(): GPUBindGroup {
    return this.skinBindGroup;
  }

  public getPreviousSkinBindGroup(): GPUBindGroup {
    return this.previousSkinBindGroup;
  }

  // Duck-typed by VelocityBufferManager to identify skinned render keys.
  public getVelocitySkinPairBindGroup(): GPUBindGroup {
    return this.velocitySkinPairBindGroup;
  }

  public renderDebug(): void {}
}
