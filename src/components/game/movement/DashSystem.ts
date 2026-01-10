import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { CollisionGroups } from '../../../types/CollisionGroups.enum';
import RAPIER from '@dimforge/rapier3d';

/**
 * DashSystem - Gestiona el dash hacia puntos específicos
 */
export class DashSystem {
  // Parámetros de dash
  private dashDetectionDistance: number = 8.0;
  private dashSpeed: number = 50.0;
  private dashStopDistance: number = 0.5;

  // Estado interno
  private dashTargetPos: vec3 = vec3.create();
  private canDash: boolean = true;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  public update(): void {
    const input = Engine.getInput();

    if (
      this.controller.getIsDashing() ||
      this.controller.getIsMantling() ||
      this.controller.getIsSwinging() ||
      !this.canDash
    ) {
      return;
    }

    if (input.isActionJustPressed(GameAction.DASH)) {
      const dashPoint = this.detectDashPoint();
      if (dashPoint) {
        this.startDash(dashPoint);
      }
    }
  }

  public updateDashMovement(): vec3 {
    const collider = this.controller.getCollider();
    const currentPos = collider.getRigidBody().translation();
    const pos = vec3.fromValues(currentPos.x, currentPos.y, currentPos.z);

    const direction = vec3.sub(vec3.create(), this.dashTargetPos, pos);
    const distanceToTarget = vec3.length(direction);

    if (distanceToTarget < this.dashStopDistance) {
      this.endDash();
    }

    vec3.normalize(direction, direction);
    return vec3.scale(vec3.create(), direction, this.dashSpeed);
  }

  private detectDashPoint(): vec3 | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();
    const forward = camera.getCamera().getFront();

    const ray = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: forward[0], y: forward[1], z: forward[2] },
    );

    const interactionGroups =
      ((CollisionGroups.PLAYER & 0xffff) << 16) | (CollisionGroups.DASH_TRIGGER & 0xffff);

    const hit = physics
      .getWorld()
      .castRay(
        ray,
        this.dashDetectionDistance,
        true,
        undefined,
        interactionGroups,
        collider.getCollider(),
      );

    if (!hit) return null;

    const rigidBody = hit.collider.parent();
    if (!rigidBody) return null;

    const centerPos = rigidBody.translation();
    return vec3.fromValues(centerPos.x, centerPos.y, centerPos.z);
  }

  private startDash(targetPoint: vec3): void {
    this.controller.setIsDashing(true);
    this.canDash = false;
    vec3.copy(this.dashTargetPos, targetPoint);

    this.controller.setVerticalVelocity(0.0);
    this.controller.setIsJumping(false);
    this.controller.setIsWallRunning(false);
  }

  private endDash(): void {
    this.controller.setIsDashing(false);
  }

  public onGrounded(): void {
    this.canDash = true;
  }

  public getCanDash(): boolean {
    return this.canDash;
  }
}
