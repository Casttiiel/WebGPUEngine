import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

/**
 * WallRunSystem - Gestiona wall running y wall jumps
 */
export class WallRunSystem {
  // Parámetros de wallrun
  private minWallRunSpeed: number = 7.0;
  private initialDragFactorDuringWallRun: number = 0.85;
  private _wallRunGravity: number = -4.0;
  private detectWallDistance: number = 0.7;
  private wallRunMaxEntryAngle: number = 0.9;
  private wallDrag: number = 0.05;
  private maxWallRunDuration: number = 2.5;

  // Wall jump
  private disableInputAfterWallJumpTime: number = 0.3;

  // Estado interno
  private wallNormal: vec3 = vec3.create();
  private isNearWall: boolean = false;
  private currentWallRunTime: number = 0.0;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  public detectWall(): void {
    this.isNearWall = false;

    const camera = this.controller.getCamera();
    if (!camera) return;

    const facingVector = camera.getCamera().getFront();
    facingVector[1] = 0;
    vec3.normalize(facingVector, facingVector);

    const left = camera.getCamera().getLeft();
    left[1] = 0;
    vec3.normalize(left, left);

    const right = vec3.scale(vec3.create(), left, -1);
    const origin = this.controller.getCollider().getRigidBody().translation();
    const physics = Engine.getPhysics();

    // Raycast izquierda
    const leftRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: left[0], y: left[1], z: left[2] },
    );
    const leftHit = physics
      .getWorld()
      .castRayAndGetNormal(
        leftRay,
        this.detectWallDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.controller.getCollider().getCollider(),
      );

    if (
      leftHit &&
      leftHit.collider &&
      leftHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(leftHit.normal.x, leftHit.normal.y, leftHit.normal.z);
      const facing = vec3.dot(facingVector, n);
      if (facing >= -this.wallRunMaxEntryAngle) {
        this.isNearWall = true;
        vec3.copy(this.wallNormal, n);
      }
    }

    // Raycast derecha
    const rightRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: right[0], y: right[1], z: right[2] },
    );
    const rightHit = physics
      .getWorld()
      .castRayAndGetNormal(
        rightRay,
        this.detectWallDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.controller.getCollider().getCollider(),
      );

    if (
      rightHit &&
      rightHit.collider &&
      rightHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(rightHit.normal.x, rightHit.normal.y, rightHit.normal.z);
      const facing = vec3.dot(facingVector, n);
      if (facing >= -this.wallRunMaxEntryAngle) {
        this.isNearWall = true;
        vec3.copy(this.wallNormal, n);
      }
    }

    // Raycast atrás
    const backRay = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: -facingVector[0], y: -facingVector[1], z: -facingVector[2] },
    );
    const backHit = physics
      .getWorld()
      .castRayAndGetNormal(
        backRay,
        this.detectWallDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.controller.getCollider().getCollider(),
      );

    if (
      backHit &&
      backHit.collider &&
      backHit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed
    ) {
      const n = vec3.fromValues(backHit.normal.x, backHit.normal.y, backHit.normal.z);
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }

    // Iniciar o terminar wallrun
    if (
      this.isNearWall &&
      !this.controller.getIsGrounded() &&
      !this.controller.getIsMantling() &&
      !this.controller.getIsWallRunning()
    ) {
      this.startWallRun();
    } else if (this.controller.getIsGrounded()) {
      this.controller.setIsWallRunning(false);
    }
  }

  private startWallRun(): void {
    const speed = this.controller.getCurrentSpeed();
    if (speed < this.minWallRunSpeed) return;

    this.controller.setIsWallRunning(true);
    this.currentWallRunTime = 0.0;

    if (this.controller.getVerticalVelocity() < 0.0) {
      this.controller.setVerticalVelocity(0.0);
    }

    this.removeVelocityIntoWall(this.wallNormal);
  }

  public update(deltaTime: number, targetMovement: vec3): void {
    const input = Engine.getInput();
    this.currentWallRunTime += deltaTime;

    // Salir si nos alejamos de la pared
    if (!this.isNearWall || this.currentWallRunTime >= this.maxWallRunDuration) {
      this.controller.setIsWallRunning(false);
      return;
    }

    // Wall jump
    if (input.isActionBuffered(GameAction.JUMP)) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.applyWallJump();
      return;
    }

    // Movimiento horizontal durante wallrun
    this.updateHorizontalMovement(deltaTime, targetMovement);
  }

  private updateHorizontalMovement(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;

    // Solo puedes ir hacia adelante o atrás de la pared
    let wallTangent = this.projectOntoWallTangent(targetMovement, this.wallNormal);
    vec3.normalize(wallTangent, wallTangent);
    vec3.copy(targetMovement, wallTangent);

    const currentVel = this.controller.getHorizontalVelocity();
    const horizontalDirection = vec3.normalize(vec3.create(), currentVel);
    const alignment = vec3.dot(targetMovement, horizontalDirection);

    let keysFactor = 1.0;
    if (hasInput && alignment > 0.0) {
      keysFactor = 0.5;
    } else if (hasInput && alignment <= 0.0) {
      keysFactor = 2.0;
    }

    const dragFactor = Math.pow(1.0 - this.wallDrag * keysFactor, deltaTime);
    vec3.scale(currentVel, currentVel, dragFactor);
    this.controller.setHorizontalVelocity(currentVel);
  }

  private applyWallJump(): void {
    this.isNearWall = false;
    this.controller.setIsWallRunning(false);
    this.controller.setInputDisableTimer(this.disableInputAfterWallJumpTime);

    const camera = this.controller.getCamera();
    if (!camera) return;

    let jumpDir = camera.getCamera().getFront();
    jumpDir[1] = 0.0;
    vec3.normalize(jumpDir, jumpDir);

    const d = vec3.dot(jumpDir, this.wallNormal);
    if (d < 0.2) {
      vec3.add(jumpDir, jumpDir, this.wallNormal);
      vec3.normalize(jumpDir, jumpDir);
    }

    const speed = this.controller.getCurrentSpeed();
    const newVel = vec3.scale(vec3.create(), jumpDir, speed * 0.85);
    this.controller.setHorizontalVelocity(newVel);

    // Aplicar salto (necesitamos acceso al JumpSystem)
    this.controller.applyJumpFromSystem();
  }

  private removeVelocityIntoWall(collisionNormal: vec3): void {
    const currentVel = this.controller.getHorizontalVelocity();
    const speed = vec3.length(currentVel);

    const dot =
      currentVel[0] * collisionNormal[0] +
      currentVel[1] * collisionNormal[1] +
      currentVel[2] * collisionNormal[2];

    if (dot < 0) {
      currentVel[0] -= dot * collisionNormal[0];
      currentVel[1] -= dot * collisionNormal[1];
      currentVel[2] -= dot * collisionNormal[2];
    }

    const horizontalDirection = vec3.normalize(vec3.create(), currentVel);
    vec3.scale(currentVel, horizontalDirection, speed * this.initialDragFactorDuringWallRun);
    this.controller.setHorizontalVelocity(currentVel);
  }

  private projectOntoWallTangent(v: vec3, wallNormal: vec3): vec3 {
    const dot = vec3.dot(v, wallNormal);
    const projected = vec3.scale(vec3.create(), wallNormal, dot);
    return vec3.subtract(vec3.create(), v, projected);
  }

  // Getters públicos
  public getWallNormal(): vec3 {
    return this.wallNormal;
  }

  public getIsNearWall(): boolean {
    return this.isNearWall;
  }
}
