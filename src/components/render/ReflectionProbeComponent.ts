import { Component } from '../../core/ecs/Component';
import { Camera } from '../../core/math/Camera';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { SHData } from '../../renderer/resources/SHData';
import { ProbeManager } from '../../renderer/core/managers/ProbeManager';
import { loadProbeFaces } from '../../renderer/resources/ProbeFile';
import { ReflectionProbeComponentData } from '../../types/ReflectionProbeComponentData.type';

/**
 * A baked light/reflection probe: SH L2 irradiance (`{name}_sh.json`) and HDR radiance
 * (`{name}_env.bin`), captured from the entity's position by the F8 bake. Both apply per
 * pixel inside its influence box (`extents`, half sizes) and fade `fade` metres either side
 * of the box faces (ProbeManager / common/probes.wgsl).
 */
export class ReflectionProbeComponent extends Component {
  private radius: number = 10.0;
  /** Capture resolution per cube face (the runtime cube array resamples it). */
  private resolution: number = 128;
  private captureCamera: Camera | null = null;

  /** Half-extents of the probe influence box (x, y, z). Defaults to (radius, radius, radius). */
  private extents: vec3 = vec3.fromValues(10, 10, 10);
  /** Cross-fade distance at the box faces, per axis (metres). */
  private fade: vec3 = vec3.fromValues(1, 1, 1);
  /** Influence box centre relative to the capture point (auto-placement keeps boxes on a grid). */
  private boxOffset: vec3 = vec3.create();

  /**
   * 'indoor'  — AABB is a real room boundary: apply PCC to align reflections with geometry.
   * 'outdoor' — environment is effectively infinite: skip PCC, just use the probe's env cubemap.
   */
  private probeType: 'indoor' | 'outdoor' = 'indoor';

  /** SH L2 irradiance; replaced in place by a bake (setSH). */
  private shCoefficients: Float32Array | null = null;

  constructor() {
    super();
  }

  public load(probeData: ReflectionProbeComponentData): void {
    this.radius = probeData?.radius ?? 10.0;
    this.resolution = probeData?.resolution ?? 128;
    this.probeType = probeData?.type ?? 'indoor';

    if (probeData?.extents) {
      vec3.set(this.extents, probeData.extents[0], probeData.extents[1], probeData.extents[2]);
    } else {
      vec3.set(this.extents, this.radius, this.radius, this.radius);
    }
    if (probeData?.boxOffset) vec3.set(this.boxOffset, ...probeData.boxOffset);
    // Default: a quarter of the box per axis, at most 2 m.
    const fade = probeData?.fade;
    for (let a = 0; a < 3; a++) {
      this.fade[a] = Array.isArray(fade) ? fade[a]! : (fade ?? Math.min(2, 0.25 * 2 * this.extents[a]!));
    }

    // 90° square camera per cube face.
    this.captureCamera = new Camera();
    this.captureCamera.setFov(90);
    this.captureCamera.setViewport(this.resolution, this.resolution);
    this.captureCamera.setNearPlane(0.1);
    this.captureCamera.setFarPlane(1000.0);
  }

  public override async onAttach(): Promise<void> {
    const name = this.getOwner().getName();
    ProbeManager.getInstance().register(this);

    // Not baked yet → no files: the probe stays out of the lighting until F8.
    SHData.getAsync(`${name}_sh.json`)
      .then((sh) => {
        this.shCoefficients ??= sh.getCoefficients();
      })
      .catch(() => {});
    const faces = await loadProbeFaces(name);
    if (faces) await ProbeManager.getInstance().setProbeEnv(this, faces);
  }

  /** Installs freshly baked irradiance (the bake also saves it to disk). */
  public setSH(coefficients: Float32Array): void {
    this.shCoefficients = coefficients;
  }

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}

  public getExtents(): vec3 {
    return vec3.clone(this.extents);
  }

  public setExtents(e: vec3): void {
    vec3.copy(this.extents, e);
  }

  /** World centre of the influence box (capture point + boxOffset). */
  public getBoxCenter(): vec3 {
    return vec3.add(vec3.create(), this.getPosition(), this.boxOffset);
  }

  public getFade(): vec3 {
    return this.fade;
  }

  public getRadius(): number {
    return this.radius;
  }

  public getResolution(): number {
    return this.resolution;
  }

  public getCaptureCamera(): Camera | null {
    return this.captureCamera;
  }

  public getPosition(): vec3 {
    const transform = this.getOwner().getComponent('transform');
    if (!transform) {
      return vec3.create();
    }
    return (transform as TransformComponent).getTransform().getWorldPosition();
  }

  /** The 27-float SH L2 irradiance coefficients, or null while not loaded/baked. */
  public getSHCoefficients(): Float32Array | null {
    return this.shCoefficients;
  }

  public getProbeType(): 'indoor' | 'outdoor' {
    return this.probeType;
  }

  /** Packed in ProbeGPU.pos.w: 1 = outdoor (no PCC), 2 = indoor (PCC). */
  public getProbeTypeFlag(): number {
    return this.probeType === 'indoor' ? 2.0 : 1.0;
  }

  public override dispose(): void {
    ProbeManager.getInstance().unregister(this);
    super.dispose();
  }
}
