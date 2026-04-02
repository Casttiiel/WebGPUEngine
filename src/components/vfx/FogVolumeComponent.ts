import { Component } from '../../core/ecs/Component';
import { FogVolumeComponentData } from '../../types/FogVolumeComponentData.type';
import { TransformComponent } from '../core/TransformComponent';

/**
 * FogVolumeComponent
 *
 * Defines a world-space density volume that the Froxel Density pass evaluates
 * per-froxel using a signed distance function. Supports box and sphere shapes.
 *
 * GPU buffer layout per volume (16 × f32 = 64 bytes):
 *   [0..2]  center.xyz        (world position from Transform)
 *   [3]     shape             (0 = sphere, 1 = box)
 *   [4..6]  halfExtents.xyz   (box: size * worldScale | sphere: [radius * maxScale, 0, 0])
 *   [7]     falloff           (smoothstep distance at boundary, world units)
 *   [8]     density           (base density multiplier)
 *   [9]     sigmaS            (density * scatteringCoeff)
 *   [10]    sigmaT            (sigmaS + density * absorptionCoeff)
 *   [11]    blendMode         (0 = add, 1 = override)
 *   [12..15] _pad             (padding to 64 bytes)
 */
export class FogVolumeComponent extends Component {
  private shape: 'box' | 'sphere' = 'box';
  private size: [number, number, number] = [5, 5, 5];
  private radius: number = 5;
  private density: number = 0.5;
  private scatteringCoeff: number = 1.0;
  private absorptionCoeff: number = 0.2;
  private falloff: number = 2.0;
  private blendMode: 'add' | 'override' = 'add';

  /** Cached GPU data (16 floats), refreshed every update(). */
  private gpuData: Float32Array = new Float32Array(16);

  public load(data: unknown): void {
    const d = data as FogVolumeComponentData;
    if (d.shape !== undefined) this.shape = d.shape;
    if (d.size !== undefined) this.size = d.size;
    if (d.radius !== undefined) this.radius = d.radius;
    if (d.density !== undefined) this.density = d.density;
    if (d.scatteringCoeff !== undefined) this.scatteringCoeff = d.scatteringCoeff;
    if (d.absorptionCoeff !== undefined) this.absorptionCoeff = d.absorptionCoeff;
    if (d.falloff !== undefined) this.falloff = d.falloff;
    if (d.blendMode !== undefined) this.blendMode = d.blendMode;
  }

  public update(_dt: number): void {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return;

    const worldPos = transform.getTransform().getWorldPosition();
    const worldScale = transform.getTransform().getWorldScale();

    const sigmaS = this.density * this.scatteringCoeff;
    const sigmaT = sigmaS + this.density * this.absorptionCoeff;
    const shapeFlag = this.shape === 'sphere' ? 0.0 : 1.0;
    const blendFlag = this.blendMode === 'add' ? 0.0 : 1.0;

    // center
    this.gpuData[0] = worldPos[0];
    this.gpuData[1] = worldPos[1];
    this.gpuData[2] = worldPos[2];
    // shape
    this.gpuData[3] = shapeFlag;
    // halfExtents (box: size * worldScale; sphere: radius * maxScale in .x)
    if (this.shape === 'box') {
      this.gpuData[4] = this.size[0] * worldScale[0];
      this.gpuData[5] = this.size[1] * worldScale[1];
      this.gpuData[6] = this.size[2] * worldScale[2];
    } else {
      const maxScale = Math.max(worldScale[0], worldScale[1], worldScale[2]);
      this.gpuData[4] = this.radius * maxScale;
      this.gpuData[5] = 0;
      this.gpuData[6] = 0;
    }
    // falloff
    this.gpuData[7] = this.falloff;
    // density params
    this.gpuData[8] = this.density;
    this.gpuData[9] = sigmaS;
    this.gpuData[10] = sigmaT;
    // blendMode
    this.gpuData[11] = blendFlag;
    // padding [12..15] already zero from construction
  }

  /** Returns the packed 16-float GPU data for this volume. Valid after update(). */
  public getGPUData(): Float32Array {
    return this.gpuData;
  }

  public renderDebug(): void {}
}
