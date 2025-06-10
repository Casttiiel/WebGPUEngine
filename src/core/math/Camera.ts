import { mat4, vec3 } from 'gl-matrix';
import { Render } from '../../renderer/core/render';

export class Camera {
  private view: mat4 = mat4.create();
  private projection: mat4 = mat4.create();
  private viewProjection: mat4 = mat4.create();

  private eye: vec3 = vec3.fromValues(0, 0, 0);
  private target: vec3 = vec3.fromValues(0, 0, -1);
  private upAux: vec3 = vec3.fromValues(0, 1, 0);

  private front: vec3 = vec3.fromValues(0, 0, -1);
  private left: vec3 = vec3.fromValues(-1, 0, 0);
  private up: vec3 = vec3.fromValues(0, 1, 0);

  private zNear: number = 0.1;
  private zFar: number = 1000.0;
  private fovRadians: number = (60 * Math.PI) / 180; // 60 degrees in radians
  private isOrtho: boolean = false;

  // Ortho parameters
  private orthoLeft: number = 0;
  private orthoTop: number = 0;
  private orthoWidth: number = 1.0;
  private orthoHeight: number = 1.0;
  private orthoCentered: boolean = false;

  // Viewport
  private viewport = {
    x0: 0,
    y0: 0,
    width: Render.width,
    height: Render.height,
  };
  private aspectRatio: number = Math.abs(this.viewport.width / this.viewport.height);

  constructor() {
    this.updateProjection();
    this.lookAt(vec3.fromValues(1, 1, 1), vec3.fromValues(0, 0, 0));
  }

  private updateViewProjection(): void {
    mat4.multiply(this.viewProjection, this.projection, this.view);
  }

  private updateProjection(): void {
    if (this.isOrtho) {
      if (this.orthoCentered) {
        mat4.ortho(
          this.projection,
          -this.orthoWidth / 2,
          this.orthoWidth / 2,
          -this.orthoHeight / 2,
          this.orthoHeight / 2,
          this.zNear,
          this.zFar,
        );
      } else {
        mat4.ortho(
          this.projection,
          this.orthoLeft,
          this.orthoLeft + this.orthoWidth,
          this.orthoTop - this.orthoHeight,
          this.orthoTop,
          this.zNear,
          this.zFar,
        );
      }
    } else {
      mat4.perspective(this.projection, this.fovRadians, this.aspectRatio, this.zNear, this.zFar);
    }
    this.updateViewProjection();
  }

  public setProjectionParams(fovRadians: number, zNear: number, zFar: number): void {
    this.isOrtho = false;
    this.fovRadians = fovRadians;
    this.zNear = zNear;
    this.zFar = zFar;
    this.updateProjection();
  }

  public setOrthoParams(
    centered: boolean,
    left: number,
    width: number,
    top: number,
    height: number,
    zNear: number,
    zFar: number,
  ): void {
    this.isOrtho = true;
    this.orthoCentered = centered;
    this.orthoLeft = left;
    this.orthoWidth = width;
    this.orthoTop = top;
    this.orthoHeight = height;
    this.zNear = zNear;
    this.zFar = zFar;

    this.aspectRatio = Math.abs(width / height);
    this.updateProjection();
  }

  public lookAt(newEye: vec3, newTarget: vec3, newUpAux: vec3 = vec3.fromValues(0, 1, 0)): void {
    vec3.copy(this.eye, newEye);
    vec3.copy(this.target, newTarget);
    vec3.copy(this.upAux, newUpAux);

    mat4.lookAt(this.view, this.eye, this.target, this.upAux);

    // Regenerate 3 main axes
    vec3.sub(this.front, this.target, this.eye);
    vec3.normalize(this.front, this.front);

    vec3.cross(this.left, this.upAux, this.front);
    vec3.normalize(this.left, this.left);

    vec3.cross(this.up, this.front, this.left);

    this.updateViewProjection();
  }

  public setViewport(width: number, height: number): void {
    this.viewport.width = width;
    this.viewport.height = height;

    this.aspectRatio = width / height;

    if (!this.isOrtho) {
      this.updateProjection();
    }
  }

  public getScreenCoordsOfWorldCoord(worldPos: vec3): {
    screenCoords: vec3;
    isInsideFrustum: boolean;
  } {
    const posInHomoSpace = vec3.create();
    vec3.transformMat4(posInHomoSpace, worldPos, this.viewProjection);

    const posInScreenSpace = vec3.fromValues(
      this.viewport.x0 + (posInHomoSpace[0] + 1.0) * 0.5 * this.viewport.width,
      this.viewport.y0 + (1.0 - posInHomoSpace[1]) * 0.5 * this.viewport.height,
      posInHomoSpace[2],
    );

    const isInsideFrustum =
      posInHomoSpace[0] >= -1.0 &&
      posInHomoSpace[0] <= 1.0 &&
      posInHomoSpace[1] >= -1.0 &&
      posInHomoSpace[1] <= 1.0 &&
      posInHomoSpace[2] >= 0.0 &&
      posInHomoSpace[2] <= 1.0;

    return { screenCoords: posInScreenSpace, isInsideFrustum };
  }

  public move(delta: number[]): void {
    vec3.add(this.eye, this.eye, delta as vec3);
    vec3.add(this.target, this.target, delta as vec3);
    this.lookAt(this.eye, this.target, this.upAux);
  }

  public rotate(yaw: number, pitch: number): void {
    // Aplicar rotación yaw (alrededor del eje Y)
    const rotMat = mat4.create();
    mat4.rotate(rotMat, rotMat, yaw, this.upAux);
    vec3.transformMat4(this.front, this.front, rotMat);

    // Aplicar rotación pitch (alrededor del eje local X)
    const right = vec3.cross(vec3.create(), this.front, this.upAux);
    vec3.normalize(right, right);
    mat4.rotate(rotMat, mat4.create(), pitch, right);
    vec3.transformMat4(this.front, this.front, rotMat);
    vec3.normalize(this.front, this.front);

    // Calcular nueva posición del target
    vec3.add(this.target, this.eye, this.front);

    // Actualizar la cámara
    this.lookAt(this.eye, this.target, this.upAux);
  }

  public getLocalVector(vec: number[]): vec3 {
    const result = vec3.create();
    vec3.scale(result, this.left, vec[0]);
    vec3.scaleAndAdd(result, result, this.up, vec[1]);
    vec3.scaleAndAdd(result, result, this.front, vec[2]);
    return result;
  }

  // Getters
  public getView(): mat4 {
    return this.view;
  }

  public getProjection(): mat4 {
    return this.projection;
  }

  public getViewProjection(): mat4 {
    return this.viewProjection;
  }

  public setNearPlane(near: number): void {
    this.zNear = near;
    this.updateProjection();
  }

  public getNear(): number {
    return this.zNear;
  }

  public setFarPlane(far: number): void {
    this.zFar = far;
    this.updateProjection();
  }

  public getFar(): number {
    return this.zFar;
  }

  public setFov(fov: number): void {
    this.fovRadians = fov * (Math.PI / 180); // Convert degrees to radians
    this.updateProjection();
  }

  public getFov(): number {
    return this.fovRadians;
  }

  public getAspectRatio(): number {
    return this.aspectRatio;
  }

  public getPosition(): vec3 {
    return this.eye;
  }

  public getTarget(): vec3 {
    return this.target;
  }

  public getFront(): vec3 {
    return this.front;
  }

  public getLeft(): vec3 {
    return this.left;
  }

  public getUp(): vec3 {
    return this.up;
  }

  public getOrthoWidth(): number {
    return this.orthoWidth;
  }

  public getOrthoHeight(): number {
    return this.orthoHeight;
  }

  public getOrthoLeft(): number {
    return this.orthoLeft;
  }

  public getOrthoTop(): number {
    return this.orthoTop;
  }

  public isOrthoCentered(): boolean {
    return this.orthoCentered;
  }
}
