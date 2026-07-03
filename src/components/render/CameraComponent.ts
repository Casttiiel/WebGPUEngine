import { Camera } from '../../core/math/Camera';
import { Component } from '../../core/ecs/Component';
import { CameraComponentDataType } from '../../types/CameraComponentData.type';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { MouseButton } from '../../types/MouseButton.enum';
import { Render } from '../../renderer/core/pipeline/Render';
import { vec3 } from 'gl-matrix';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';

export class CameraComponent extends Component {
  protected camera: Camera;
  private isControllable: boolean = false;
  private rotationSpeed: number = 0.015;

  // ✅ Reusable temp vectors to avoid allocations in update()
  private tempMovement: vec3 = vec3.create();
  private tempInput: number[] = [0, 0, 0];

  constructor() {
    super();
    this.camera = new Camera();
  }

  public load(data: CameraComponentDataType): void {
    if (data.ortho) {
      // Configure orthographic camera
      const orthoWidth = data.orthoWidth || Render.width;
      const orthoHeight = data.orthoHeight || Render.height;
      const orthoLeft = data.orthoLeft || 0;
      const orthoTop = data.orthoTop || 0;
      const orthoCentered = data.orthoCentered !== undefined ? data.orthoCentered : true;

      this.camera.setOrthoParams(orthoCentered, orthoLeft, orthoWidth, orthoTop, orthoHeight);
    } else {
      if (data.fov) {
        this.camera.setFov(data.fov);
      }
    }

    // Configure perspective camera
    if (data.near) {
      this.camera.setNearPlane(data.near);
    }

    if (data.far) {
      this.camera.setFarPlane(data.far);
    }

    // This ensures correct aspect ratio from the start
    if (data.viewport) {
      this.camera.setViewport(data.viewport.width, data.viewport.height);
    } else {
      // If no viewport specified, use current render dimensions
      this.camera.setViewport(Render.width, Render.height);
    }

    if (data.controllable) {
      this.isControllable = data.controllable;
    }

    const position = data.position || [0, 0, 0];
    const target = data.target || [0, 0, 1];
    const up = data.up || [0, 1, 0];
    this.camera.lookAt(position, target, up);
    this.camera.updateUniforms(0);
  }

  public update(dt: number): void {
    if (this.isControllable) {
      const input = Engine.getInput();
      const multiplier = input.isKeyPressed(KeyCode.SHIFT) ? 10.0 : 1.0;
      const moveSpeed = 4.0 * multiplier * dt;

      // Movimiento de la cámara
      if (input.isKeyPressed(KeyCode.A)) {
        this.tempInput[0] = moveSpeed;
        this.tempInput[1] = 0;
        this.tempInput[2] = 0;
        this.camera.getLocalVectorTo(this.tempInput, this.tempMovement);
        this.camera.move(this.tempMovement);
      }
      if (input.isKeyPressed(KeyCode.D)) {
        this.tempInput[0] = -moveSpeed;
        this.tempInput[1] = 0;
        this.tempInput[2] = 0;
        this.camera.getLocalVectorTo(this.tempInput, this.tempMovement);
        this.camera.move(this.tempMovement);
      }
      if (input.isKeyPressed(KeyCode.W)) {
        this.tempInput[0] = 0;
        this.tempInput[1] = 0;
        this.tempInput[2] = moveSpeed;
        this.camera.getLocalVectorTo(this.tempInput, this.tempMovement);
        this.camera.move(this.tempMovement);
      }
      if (input.isKeyPressed(KeyCode.S)) {
        this.tempInput[0] = 0;
        this.tempInput[1] = 0;
        this.tempInput[2] = -moveSpeed;
        this.camera.getLocalVectorTo(this.tempInput, this.tempMovement);
        this.camera.move(this.tempMovement);
      }

      // Rotación de la cámara con el ratón
      if (input.isMouseButtonPressed(MouseButton.RIGHT)) {
        const mouseDelta = input.getMouseDelta();
        this.camera.rotate(-mouseDelta.x * this.rotationSpeed, -mouseDelta.y * this.rotationSpeed);
      }

      const mouseWheelDelta = input.getMouseWheelDelta();
      if (mouseWheelDelta !== 0) {
        this.tempMovement[0] = 0;
        this.tempMovement[1] = -0.05 * multiplier * mouseWheelDelta * dt;
        this.tempMovement[2] = 0;
        this.camera.move(this.tempMovement);
      }
    }

    this.camera.updateUniforms(dt);
  }

  public override renderInMenu(): void {}

  public override renderDebug(filter?: string): void {
    if (filter && filter !== 'render' && filter !== 'all') return;
    const invVP = this.camera.getInvViewProjectionMatrix();
    PhysicsDebugDrawer.getInstance().addFrustumSlices(invVP, [1.0, 1.0, 0.0, 1.0]);
  }

  public getCamera(): Camera {
    return this.camera;
  }

  public setCamera(camera: Camera): void {
    this.camera = camera;
  }

  public setActive(active: boolean): void {
    this.isControllable = active;
  }
}
