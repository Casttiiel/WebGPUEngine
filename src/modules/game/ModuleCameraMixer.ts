import { vec3 } from "gl-matrix";
import { CameraComponent } from "../../components/render/CameraComponent";
import { Entity } from "../../core/ecs/Entity";
import { Camera } from "../../core/math/Camera";
import { Render } from "../../renderer/core/render";
import { Interpolator } from "../../types/interpolator.interface";
import { MixedCamera } from "../../types/MixedCamera.type";
import { Module } from "../core/Module";


export class ModuleCameraMixer extends Module {
  private mixedCameras: MixedCamera[] = [];
  private defaultCamera!: Entity;
  private outputCamera!: Entity;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    return true;
  }

  public stop(): void { }

  public update(dt: number): void {
    // Update mixed cameras weights
    let weight = 1.0;
    for (let i = this.mixedCameras.length - 1; i >= 0; i--) {
      const mc = this.mixedCameras[i];

      if (mc.blendedWeight < 1.0) {
        mc.blendedWeight = this.clamp(
          mc.blendedWeight + dt / mc.blendTime,
          0.0,
          1.0
        );
      }

      mc.appliedWeight = mc.blendedWeight * Math.min(mc.targetWeight, weight);
      weight -= mc.appliedWeight;
    }

    // Remove dead cameras
    this.mixedCameras = this.mixedCameras.filter(mc => mc.appliedWeight > 0.0);

    // Blend all active cameras
    let result = new Camera();

    const defaultCameraComponent = this.getCameraComponentFromEntity(this.defaultCamera);
    if (defaultCameraComponent) {
      defaultCameraComponent.setCamera(result);
    }

    for (const mc of this.mixedCameras) {
      const cameraComponent = this.getCameraComponentFromEntity(mc.cameraEntity);
      if (!cameraComponent) continue;

      let ratio = mc.blendedWeight;
      ratio = mc.interpolator.blend(0.0, 1.0, ratio);

      if (isNaN(ratio)) {
        throw new Error("NaN ratio in camera mixer");
        ratio = 0.0;
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
      targetWeight: 1.0
    };

    this.mixedCameras.push(mc);
  }

  private blendCameras(
    camera1: Camera,
    camera2: Camera,
    ratio: number,
  ): Camera {
    if (!camera1 || !camera2 || ratio <= 0.0) throw new Error("Invalid cameras or ratio");

    let output = new Camera();

    const newPosition = vec3.lerp(
      vec3.create(),
      camera1.getPosition(),
      camera2.getPosition(),
      ratio
    );

    const newFront = vec3.lerp(
      vec3.create(),
      camera1.getFront(),
      camera2.getFront(),
      ratio
    );

    const newUp = vec3.lerp(
      vec3.create(),
      camera1.getUp(),
      camera2.getUp(),
      ratio
    );

    const newFov =
      camera1.getFov() * (1.0 - ratio) + camera2.getFov() * ratio;
    const newZNear =
      camera1.getNear() * (1.0 - ratio) + camera2.getNear() * ratio;
    const newZFar =
      camera1.getFar() * (1.0 - ratio) + camera2.getFar() * ratio;

    output.setProjectionParams(newFov, newZNear, newZFar);
    output.setViewport(0, 0, Render.width, Render.height);
    output.lookAt(newPosition, vec3.add(vec3.create(), newPosition, newFront), newUp);

    return output;
  }

  private getCameraComponentFromEntity(entity: Entity): CameraComponent | null {
    return entity.getComponent("camera") as CameraComponent;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  public renderDebug(): void { }

  public renderInMenu(): void {
    
  }
}


// Implementaciones básicas de interpoladores
class LinearInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    return start + (end - start) * ratio;
  }
}

class QuadInInterpolator implements Interpolator {
  blend(start: number, end: number, ratio: number): number {
    return start + (end - start) * ratio * ratio;
  }
}