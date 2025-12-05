import { Component } from '../../core/ecs/Component';
import { Camera } from '../../core/math/Camera';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';

export class ReflectionProbeComponent extends Component {
  private radius: number = 10.0; // Radio de influencia
  private resolution: number = 512; // Resolución del cubemap (512x512 por cara)
  private captureCamera: Camera | null = null;

  constructor() {
    super();
  }

  public load(data: unknown): void {
    const probeData = data as { radius?: number; resolution?: number };
    this.radius = probeData?.radius ?? 10.0;
    this.resolution = probeData?.resolution ?? 512;

    // Crear cámara de captura con FOV 90° para cubemap
    this.captureCamera = new Camera();
    this.captureCamera.setFov(90); // FOV 90° para cubemap
    this.captureCamera.setViewport(this.resolution, this.resolution); // Aspect 1:1
    this.captureCamera.setNearPlane(0.1);
    this.captureCamera.setFarPlane(1000.0); // Far plane extendido para capturar más escena
  }

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}

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
}
