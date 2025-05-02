import { vec3, quat, mat4 } from "gl-matrix";

export class Transform {
  private rotation: quat = quat.create();
  private position: vec3 = vec3.create();
  private scale: vec3 = vec3.fromValues(1, 1, 1);

  constructor() {}

  public getPosition(): vec3 {
    return this.position;
  }

  public getRotation(): quat {
    return this.rotation;
  }

  public setPosition(newPosition: vec3): void {
    vec3.copy(this.position, newPosition);
  }

  public setRotation(newRotation: quat): void {
    quat.copy(this.rotation, newRotation);
  }

  public setScale(newScale: vec3): void {
    vec3.copy(this.scale, newScale);
  }

  public getScale(): vec3 {
    return this.scale;
  }

  public asMatrix(): mat4 {
    const matrix = mat4.create();
    mat4.fromRotationTranslationScale(matrix, this.rotation, this.position, this.scale);
    return matrix;
  }

  public fromMatrix(matrix: mat4): void {
    const scaleVec = vec3.create();
    mat4.getScaling(scaleVec, matrix);
    vec3.copy(this.scale, scaleVec);
    mat4.getRotation(this.rotation, matrix);
    mat4.getTranslation(this.position, matrix);
  }

  public getFront(): vec3 {
    const front = vec3.fromValues(0, 0, -1);
    vec3.transformQuat(front, front, this.rotation);
    return front;
  }

  public getUp(): vec3 {
    const up = vec3.fromValues(0, 1, 0);
    vec3.transformQuat(up, up, this.rotation);
    return up;
  }

  public getLeft(): vec3 {
    const left = vec3.fromValues(-1, 0, 0);
    vec3.transformQuat(left, left, this.rotation);
    return left;
  }

  public getRight(): vec3 {
    const right = vec3.fromValues(1, 0, 0);
    vec3.transformQuat(right, right, this.rotation);
    return right;
  }

  public lookAt(eye: vec3, target: vec3, up: vec3 = vec3.fromValues(0, 1, 0)): void {
    vec3.copy(this.position, eye);
    const matrix = mat4.create();
    mat4.targetTo(matrix, eye, target, up);
    mat4.getRotation(this.rotation, matrix);
  }

  public combineWith(deltaTransform: Transform): Transform {
    const newTransform = new Transform();
    quat.multiply(newTransform.rotation, deltaTransform.rotation, this.rotation);

    const deltaPositionRotated = vec3.create();
    vec3.transformQuat(deltaPositionRotated, deltaTransform.position, this.rotation);
    vec3.multiply(deltaPositionRotated, deltaPositionRotated, this.scale);
    vec3.add(newTransform.position, this.position, deltaPositionRotated);

    vec3.multiply(newTransform.scale, this.scale, deltaTransform.scale);
    return newTransform;
  }

  public getDeltaYawToAimTo(target: vec3): number {
    const dirToTarget = vec3.create();
    vec3.subtract(dirToTarget, target, this.position);
    const left = this.getLeft();
    const front = this.getFront();
    const dotLeft = vec3.dot(left, dirToTarget);
    const dotFront = vec3.dot(front, dirToTarget);
    return Math.atan2(dotLeft, dotFront);
  }

  public getDeltaPitchToAimTo(target: vec3): number {
    const dirToTarget = vec3.create();
    vec3.subtract(dirToTarget, target, this.position);
    return -Math.atan2(dirToTarget[1], Math.sqrt(dirToTarget[0] ** 2 + dirToTarget[2] ** 2));
  }

  public rotateTowards(targetPoint: vec3, rotSpeed: number, dt: number): void {
    const rotSpeedRad = (rotSpeed * Math.PI) / 180;
    const deltaYaw = this.getDeltaYawToAimTo(targetPoint);
    const angles = this.getAngles();

    if (Math.abs(deltaYaw) <= rotSpeedRad * dt) {
      angles.yaw += deltaYaw;
    } else {
      angles.yaw += deltaYaw > 0 ? rotSpeedRad * dt : -rotSpeedRad * dt;
    }

    this.setAngles(angles.yaw, angles.pitch, angles.roll);
  }

  public getAngles(): { yaw: number; pitch: number; roll: number } {
    const front = this.getFront();
    // Convert front vector to yaw and pitch
    const yaw = Math.atan2(front[0], front[2]);
    const pitch = Math.asin(-front[1]);

    const left = this.getLeft();
    const up = this.getUp();
    const roll = Math.atan2(vec3.dot(left, up), vec3.dot(left, this.getLeft()));

    return { yaw, pitch, roll };
  }

  public setAngles(yaw: number, pitch: number, roll: number = 0): void {
    // quat.fromEuler espera (out, x, y, z) donde:
    // x = rotación alrededor del eje X (pitch)
    // y = rotación alrededor del eje Y (yaw)
    // z = rotación alrededor del eje Z (roll)
    quat.fromEuler(this.rotation, pitch, yaw, roll);
    quat.normalize(this.rotation, this.rotation);
  }
}