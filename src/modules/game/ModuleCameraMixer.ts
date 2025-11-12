import { vec3 } from 'gl-matrix';
import { CameraComponent } from '../../components/render/CameraComponent';
import { Entity } from '../../core/ecs/Entity';
import { Camera } from '../../core/math/Camera';
import { Render } from '../../renderer/core/pipeline/Render';
import { Interpolator } from '../../types/Interpolator.interface';
import { MixedCamera } from '../../types/MixedCamera.type';
import { Module } from '../core/Module';
import { LinearInterpolator } from '../../core/math/Interpolators';
import { Engine } from '../../core/engine/Engine';

export class ModuleCameraMixer extends Module {
  private mixedCameras: MixedCamera[] = [];
  private defaultCamera!: Entity;
  private outputCamera!: Entity;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    this.setDefaultCamera(Engine.getEntities().getEntityByName('PlayerCamera')!);
    this.setOutputCamera(Engine.getEntities().getEntityByName('MainCamera')!);

    this.blendCamera(this.defaultCamera, 0.0, new LinearInterpolator());
    return true;
  }

  public stop(): void {}

  public update(dt: number): void {
    // Update mixed cameras weights
    let weight = 1.0;
    for (let i = this.mixedCameras.length - 1; i >= 0; i--) {
      const mc = this.mixedCameras[i];

      if (mc && mc.blendedWeight < 1.0) {
        mc.blendedWeight = this.clamp(mc.blendedWeight + dt / mc.blendTime, 0.0, 1.0);
      }

      if (mc) {
        mc.appliedWeight = mc.blendedWeight * Math.min(mc.targetWeight, weight);
        weight -= mc.appliedWeight;
      }
    }

    // Remove dead cameras
    this.mixedCameras = this.mixedCameras.filter((mc) => mc.appliedWeight > 0.0);

    // Blend all active cameras
    let result = this.getCameraComponentFromEntity(this.defaultCamera)!.getCamera();

    for (const mc of this.mixedCameras) {
      const cameraComponent = this.getCameraComponentFromEntity(mc.cameraEntity);
      if (!cameraComponent) continue;

      let ratio = mc.blendedWeight;
      ratio = mc.interpolator.blend(0.0, 1.0, ratio);

      if (isNaN(ratio)) {
        throw new Error('NaN ratio in camera mixer');
      }

      result = this.blendCameras(result, cameraComponent.getCamera(), ratio);
    }

    const outputCamera = this.getCameraComponentFromEntity(this.outputCamera);
    if (outputCamera) {
      outputCamera.setCamera(result);
    }
  }

  public blendCamera(camera: Entity, blendTime: number, interpolator: Interpolator): void {
    const mc: MixedCamera = {
      cameraEntity: camera,
      blendTime,
      interpolator,
      blendedWeight: 0.0,
      appliedWeight: 0.0,
      targetWeight: 1.0,
    };

    this.mixedCameras.push(mc);
  }

  private blendCameras(camera1: Camera, camera2: Camera, ratio: number): Camera {
    if (!camera1 || !camera2 || ratio <= 0.0) throw new Error('Invalid cameras or ratio');

    const output = new Camera();

    const newPosition = vec3.lerp(
      vec3.create(),
      camera1.getPosition(),
      camera2.getPosition(),
      ratio,
    );

    const newFront = vec3.lerp(vec3.create(), camera1.getFront(), camera2.getFront(), ratio);

    const newUp = vec3.lerp(vec3.create(), camera1.getUp(), camera2.getUp(), ratio);

    const newFov = camera1.getFov() * (1.0 - ratio) + camera2.getFov() * ratio;
    const newZNear = camera1.getNear() * (1.0 - ratio) + camera2.getNear() * ratio;
    const newZFar = camera1.getFar() * (1.0 - ratio) + camera2.getFar() * ratio;

    output.setProjectionParams(newFov, newZNear, newZFar);
    output.setViewport(Render.width, Render.height);
    output.lookAt(newPosition, vec3.add(vec3.create(), newPosition, newFront), newUp);

    return output;
  }

  private getCameraComponentFromEntity(entity: Entity): CameraComponent | null {
    return entity.getComponent('camera') as CameraComponent;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private setDefaultCamera(camera: Entity) {
    this.defaultCamera = camera;
  }
  private setOutputCamera(camera: Entity) {
    this.outputCamera = camera;
  }

  public renderDebug(): void {}

  public override renderInMenu(): void {}
}
