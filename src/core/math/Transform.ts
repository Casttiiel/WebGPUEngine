import { vec3, quat, mat4 } from "gl-matrix";

export class Transform {
  // Local transforms
  private localRotation: quat = quat.create();
  private localPosition: vec3 = vec3.create();
  private localScale: vec3 = vec3.fromValues(1, 1, 1);
  
  // World transforms (cached)
  private worldRotation: quat = quat.create();
  private worldPosition: vec3 = vec3.create();
  private worldScale: vec3 = vec3.fromValues(1, 1, 1);
  
  // Cache control 
  private isDirty: boolean = true;

  constructor() {}

  // Position methods
  public getLocalPosition(): vec3 {
    return this.localPosition;
  }

  public getWorldPosition(): vec3 {
    return this.worldPosition;
  }

  public setLocalPosition(newPosition: vec3): void {
    vec3.copy(this.localPosition, newPosition);
    this.isDirty = true;
  }

  public setWorldPosition(newPosition: vec3): void {
    vec3.copy(this.worldPosition, newPosition);
  }

  // Rotation methods
  public getLocalRotation(): quat {
    return this.localRotation;
  }

  public getWorldRotation(): quat {
    return this.worldRotation;
  }

  public setLocalRotation(newRotation: quat): void {
    quat.copy(this.localRotation, newRotation);
    this.isDirty = true;
  }

  public setWorldRotation(newRotation: quat): void {
    quat.copy(this.worldRotation, newRotation);
  }

  // Scale methods
  public getLocalScale(): vec3 {
    return this.localScale;
  }

  public getWorldScale(): vec3 {
    return this.worldScale;
  }

  public setLocalScale(newScale: vec3): void {
    vec3.copy(this.localScale, newScale);
    this.isDirty = true;
  }

  public setWorldScale(newScale: vec3): void {
    vec3.copy(this.worldScale, newScale);
  }

  // Matrix conversions
  public getLocalMatrix(): mat4 {
    const matrix = mat4.create();
    mat4.fromRotationTranslationScale(matrix, this.localRotation, this.localPosition, this.localScale);
    return matrix;
  }

  public getWorldMatrix(): mat4 {
    const matrix = mat4.create();
    mat4.fromRotationTranslationScale(matrix, this.worldRotation, this.worldPosition, this.worldScale);
    return matrix;
  }

  public updateWorldTransform(parentWorldTransform?: Transform): void {
    if (!this.isDirty && !parentWorldTransform) return;

    if (parentWorldTransform) {
      // Update world position
      vec3.transformQuat(this.worldPosition, this.localPosition, parentWorldTransform.getWorldRotation());
      vec3.multiply(this.worldPosition, this.worldPosition, parentWorldTransform.getWorldScale());
      vec3.add(this.worldPosition, this.worldPosition, parentWorldTransform.getWorldPosition());

      // Update world rotation
      quat.multiply(this.worldRotation, parentWorldTransform.getWorldRotation(), this.localRotation);

      // Update world scale
      vec3.multiply(this.worldScale, parentWorldTransform.getWorldScale(), this.localScale);
    } else {
      // No parent, world transforms are same as local
      vec3.copy(this.worldPosition, this.localPosition);
      quat.copy(this.worldRotation, this.localRotation);
      vec3.copy(this.worldScale, this.localScale);
    }

    this.isDirty = false;
  }

  public fromMatrix(matrix: mat4): void {
    const scaleVec = vec3.create();
    mat4.getScaling(scaleVec, matrix);
    const rotationQuat = quat.create();
    mat4.getRotation(rotationQuat, matrix);
    const positionVec = vec3.create();
    mat4.getTranslation(positionVec, matrix);

    this.setLocalScale(scaleVec);
    this.setLocalRotation(rotationQuat);
    this.setLocalPosition(positionVec);
  }

  // Direction vectors
  public getFront(): vec3 {
    const front = vec3.fromValues(0, 0, -1);
    vec3.transformQuat(front, front, this.worldRotation);
    return front;
  }

  public getUp(): vec3 {
    const up = vec3.fromValues(0, 1, 0);
    vec3.transformQuat(up, up, this.worldRotation);
    return up;
  }

  public getRight(): vec3 {
    const right = vec3.fromValues(1, 0, 0);
    vec3.transformQuat(right, right, this.worldRotation);
    return right;
  }

  public getLeft(): vec3 {
    const left = vec3.fromValues(-1, 0, 0);
    vec3.transformQuat(left, left, this.worldRotation);
    return left;
  }

  // Rotation helpers
  public setAngles(yaw: number, pitch: number, roll: number = 0): void {
    quat.fromEuler(this.localRotation, pitch, yaw, roll);
    quat.normalize(this.localRotation, this.localRotation);
    this.isDirty = true;
  }

  public getAngles(): { yaw: number; pitch: number; roll: number } {
    const front = this.getFront();
    const yaw = Math.atan2(front[0], front[2]);
    const pitch = Math.asin(-front[1]);
    const right = this.getRight();
    const up = this.getUp();
    const roll = Math.atan2(vec3.dot(right, up), vec3.dot(right, this.getRight()));
    return { yaw, pitch, roll };
  }

  public getDeltaYawToAimTo(target: vec3): number {
    const dirToTarget = vec3.create();
    vec3.subtract(dirToTarget, target, this.worldPosition);
    const left = this.getLeft();
    const front = this.getFront();
    const dotLeft = vec3.dot(left, dirToTarget);
    const dotFront = vec3.dot(front, dirToTarget);
    return Math.atan2(dotLeft, dotFront);
  }

  public getDeltaPitchToAimTo(target: vec3): number {
    const dirToTarget = vec3.create();
    vec3.subtract(dirToTarget, target, this.worldPosition);
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

  public lookAt(eye: vec3, target: vec3, up: vec3 = vec3.fromValues(0, 1, 0)): void {
    vec3.copy(this.localPosition, eye);
    const matrix = mat4.create();
    mat4.targetTo(matrix, eye, target, up);
    mat4.getRotation(this.localRotation, matrix);
    this.isDirty = true;
  }

  public combineWith(deltaTransform: Transform): Transform {
    const newTransform = new Transform();

    // Combine rotations
    quat.multiply(newTransform.localRotation, deltaTransform.getLocalRotation(), this.localRotation);

    // Combine positions
    const deltaPositionRotated = vec3.create();
    vec3.transformQuat(deltaPositionRotated, deltaTransform.getLocalPosition(), this.localRotation);
    vec3.multiply(deltaPositionRotated, deltaPositionRotated, this.localScale);
    vec3.add(newTransform.localPosition, this.localPosition, deltaPositionRotated);

    // Combine scales
    vec3.multiply(newTransform.localScale, this.localScale, deltaTransform.getLocalScale());

    newTransform.isDirty = true;
    return newTransform;
  }
}