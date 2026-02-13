import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { CharacterControllerComponentDataType } from '../../../types/CharacterControllerComponentData.type';

/**
 * WallRunSystem - Gestiona wall running y wall jumps
 */
export class WallRunSystem {
  // Parámetros de wallrun
  private initialDragFactorDuringWallRun: number = 1.0;
  private startWallRunGravity: number = 2.5;
  private detectWallDistance: number = 0.6;
  private maxWallRunDuration: number = 10.0;
  private runSpeed = 9.0;
  private wallAcceleration: number = 3.0;

  // Wall jump
  private disableInputAfterWallJumpTime: number = 2.9;

  // Estado interno
  private wallNormal: vec3 = vec3.create();
  private isNearWall: boolean = false;
  private wallRunCooldown: number = 0.0;
  private wallRunCooldownTimer: number = 0.0;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
    data: CharacterControllerComponentDataType,
  ) {
    this.detectWallDistance = data.detectWallDistance ?? this.detectWallDistance;
    this.startWallRunGravity = data.startWallRunGravity ?? this.startWallRunGravity;
    this.runSpeed = data.moveSpeed ?? this.runSpeed;
    this.wallAcceleration = data.wallRunAcceleration ?? this.wallAcceleration;
    this.wallRunCooldown = 0.1;
  }

  public detectWall(deltaTime: number): void {
    const input = Engine.getInput();
    this.isNearWall = false;

    // Actualizar cooldown de wallrun
    this.wallRunCooldownTimer -= deltaTime;
    if (this.wallRunCooldownTimer > 0) return;

    const camera = this.controller.getCamera();
    if (!camera) return;

    const facingVector = camera.getCamera().getFront();
    facingVector[1] = 0;
    vec3.normalize(facingVector, facingVector);
    const backVector = vec3.negate(vec3.create(), facingVector);

    const left = camera.getCamera().getLeft();
    left[1] = 0;
    vec3.normalize(left, left);

    const right = vec3.scale(vec3.create(), left, -1);

    const diagonalLeft = vec3.add(vec3.create(), backVector, left);
    vec3.normalize(diagonalLeft, diagonalLeft);
    const diagonalRight = vec3.add(vec3.create(), backVector, right);
    vec3.normalize(diagonalRight, diagonalRight);

    this.wallRaycast(left);
    this.wallRaycast(right);
    this.wallRaycast(backVector);
    this.wallRaycast(diagonalLeft);
    this.wallRaycast(diagonalRight);

    // Iniciar o terminar wallrun
    if (
      this.isNearWall &&
      !this.controller.getIsGrounded() &&
      !this.controller.getIsMantling() &&
      !this.controller.getIsWallRunning() &&
      input.isActionPressed(GameAction.MOVE_FORWARD)
    ) {
      this.startWallRun();
    } else if (this.controller.getIsGrounded()) {
      this.controller.setIsWallRunning(false);
    }
  }

  public wallRaycast(dir: vec3): void {
    const origin = this.controller.getCollider().getRigidBody().translation();
    const physics = Engine.getPhysics();
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = physics
      .getWorld()
      .castRayAndGetNormal(
        ray,
        this.detectWallDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.controller.getCollider().getCollider(),
      );

    if (hit && hit.collider && hit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed) {
      const n = vec3.fromValues(hit.normal.x, hit.normal.y, hit.normal.z);
      this.isNearWall = true;
      vec3.copy(this.wallNormal, n);
    }
  }

  private startWallRun(): void {
    this.controller.setIsWallRunning(true);
    this.controller.setVerticalVelocity(this.startWallRunGravity);

    this.removeVelocityIntoWall(this.wallNormal);
  }

  public update(deltaTime: number, targetMovement: vec3): void {
    const input = Engine.getInput();

    // Salir si nos alejamos de la pared
    if (!this.isNearWall || !input.isActionPressed(GameAction.MOVE_FORWARD)) {
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
    // Solo puedes ir hacia adelante o atrás de la pared
    let wallTangent = this.projectOntoWallTangent(targetMovement, this.wallNormal);
    vec3.normalize(wallTangent, wallTangent);
    vec3.copy(targetMovement, wallTangent);

    const boostedSpeed = this.controller.getBoostedSpeed();
    const baseTargetSpeed = Math.max(this.runSpeed, boostedSpeed);
    vec3.scale(targetMovement, targetMovement, baseTargetSpeed);

    const currentVel = this.controller.getHorizontalVelocity();
    const newVel = this.approachVec3(currentVel, targetMovement, this.wallAcceleration * deltaTime);
    newVel[1] = currentVel[1];

    this.controller.setHorizontalVelocity(newVel);
  }

  private applyWallJump(): void {
    this.isNearWall = false;
    this.controller.setIsWallRunning(false);
    this.controller.setInputDisableTimer(this.disableInputAfterWallJumpTime);
    this.wallRunCooldownTimer = this.wallRunCooldown;

    const camera = this.controller.getCamera();
    if (!camera) return;

    let jumpDir = camera.getCamera().getFront();
    jumpDir[1] = 0.0;
    vec3.normalize(jumpDir, jumpDir);

    const d = vec3.dot(jumpDir, this.wallNormal);
    if (d < 0.2) {
      vec3.scale(this.wallNormal, this.wallNormal, 0.5);
      vec3.add(jumpDir, jumpDir, this.wallNormal);
      vec3.normalize(jumpDir, jumpDir);
    }

    const speed = this.controller.getCurrentSpeed();
    const newVel = vec3.scale(vec3.create(), jumpDir, speed);
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

  private approachVec3(current: vec3, target: vec3, maxDelta: number): vec3 {
    const delta = vec3.create();
    vec3.subtract(delta, target, current);

    const dist = vec3.length(delta);

    if (dist <= maxDelta || dist === 0) {
      return vec3.clone(target);
    }

    const result = vec3.create();
    vec3.scaleAndAdd(result, current, delta, maxDelta / dist);
    return result;
  }

  // Getters públicos
  public getWallNormal(): vec3 {
    return this.wallNormal;
  }

  public getIsNearWall(): boolean {
    return this.isNearWall;
  }
}
