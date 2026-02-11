import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';

/**
 * MantleSystem - Gestiona el trepar (mantling)
 */
export class MantleSystem {
  // Parámetros de mantle
  private mantleDetectionDistance: number = 1.5;
  private mantleMaxHeight: number = -0.025;
  private minMantleVelocity: number = 9.0;
  private mantlingMinVerticalVelocity: number = -5.0;

  // Estado interno
  private mantleTargetPos: vec3 = vec3.create();
  private mantleStoredVelocity: number = 0.0;
  private originalHeight: number = 0.0;
  private originalRadius: number = 0.0;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
  ) {
    const collider = this.controller.getCollider();
    this.originalHeight = collider.getCapsuleHeight();
    this.originalRadius = collider.getCapsuleRadius();
  }

  public update(): void {
    const input = Engine.getInput();

    if (
      this.controller.getVerticalVelocity() < this.mantlingMinVerticalVelocity ||
      this.controller.getIsWallRunning() ||
      this.controller.getIsGrounded() ||
      this.controller.getIsMantling()
    ) {
      return;
    }

    if (input.isActionPressed(GameAction.MOVE_FORWARD)) {
      const mantleInfo = this.detectMantleOpportunity();
      if (mantleInfo) {
        this.startMantle(mantleInfo.targetPosition);
      }
    }
  }

  public updateMantleDirection(): vec3 {
    const collider = this.controller.getCollider();
    const currentPos = collider.getRigidBody().translation();
    const pos = vec3.fromValues(currentPos.x, currentPos.y, currentPos.z);

    const vector = vec3.create();
    vec3.subtract(vector, this.mantleTargetPos, pos);
    const distance = vec3.length(vector);

    if (distance < 0.3) {
      this.endMantle();
    }

    let dir = vec3.fromValues(
      this.mantleTargetPos[0] - pos[0],
      this.mantleTargetPos[1] - pos[1],
      this.mantleTargetPos[2] - pos[2],
    );
    vec3.normalize(dir, dir);
    return vec3.scale(vec3.create(), dir, this.mantleStoredVelocity);
  }

  private detectMantleOpportunity(): { targetPosition: vec3 } | null {
    const physics = Engine.getPhysics();
    const camera = this.controller.getCamera();
    if (!camera) return null;

    const collider = this.controller.getCollider();
    const playerPos = collider.getRigidBody().translation();

    let forward = camera.getCamera().getFront();
    forward[1] = 0;
    vec3.normalize(forward, forward);

    const currentSpeed = this.controller.getCurrentSpeed();
    const speedRatio = Math.min(currentSpeed / (14.0 * 2.0), 2.0);
    const dynamicDetectionDistance = this.mantleDetectionDistance * (1.0 + speedRatio * 0.8);

    // Raycast horizontal
    const ray1 = new RAPIER.Ray(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      { x: forward[0], y: 0, z: forward[2] },
    );

    const wallHit = physics
      .getWorld()
      .castRay(
        ray1,
        dynamicDetectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!wallHit) return null;
    if (wallHit.collider.parent()!.bodyType() !== RAPIER.RigidBodyType.Fixed) return null;

    // Raycast vertical
    const wallDistance = wallHit.timeOfImpact;
    const wallPoint = vec3.fromValues(
      playerPos.x + forward[0] * wallDistance,
      playerPos.y,
      playerPos.z + forward[2] * wallDistance,
    );

    const ray2 = new RAPIER.Ray(
      {
        x: wallPoint[0] + forward[0] * 0.5,
        y: playerPos.y + this.originalHeight / 2.0 + this.originalRadius,
        z: wallPoint[2] + forward[2] * 0.5,
      },
      { x: 0, y: -1, z: 0 },
    );

    const groundHit = physics
      .getWorld()
      .castRay(
        ray2,
        this.originalHeight + this.originalRadius * 2.0,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (!groundHit) return null;

    const surfaceHeight = ray2.origin.y - groundHit.timeOfImpact;

    if (surfaceHeight > camera.getCamera().getPosition()[1] + this.mantleMaxHeight) {
      return null;
    }

    // Verificar espacio arriba
    const ray3 = new RAPIER.Ray(
      {
        x: wallPoint[0] + forward[0] * 0.5,
        y: surfaceHeight + 0.1,
        z: wallPoint[2] + forward[2] * 0.5,
      },
      { x: 0, y: 1, z: 0 },
    );

    const ceilingHit = physics
      .getWorld()
      .castRay(
        ray3,
        this.originalHeight + 0.5,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        collider.getCollider(),
      );

    if (ceilingHit && ceilingHit.timeOfImpact < this.originalHeight) {
      return null;
    }

    const targetPosition = vec3.fromValues(
      wallPoint[0] + forward[0] * 0.5,
      surfaceHeight + this.originalHeight / 2.0,
      wallPoint[2] + forward[2] * 0.5,
    );
    return { targetPosition };
  }

  private startMantle(targetPosition: vec3): void {
    this.controller.setIsMantling(true);
    vec3.copy(this.mantleTargetPos, targetPosition);

    this.mantleStoredVelocity = Math.max(this.controller.getCurrentSpeed(), this.minMantleVelocity);
    this.controller.setVerticalVelocity(0.0);
  }

  private endMantle(): void {
    this.controller.setIsMantling(false);
    const currentVel = this.controller.getHorizontalVelocity();
    const normalized = vec3.normalize(vec3.create(), currentVel);
    const newVel = vec3.scale(vec3.create(), normalized, this.mantleStoredVelocity);
    this.controller.setHorizontalVelocity(newVel);
  }
}
