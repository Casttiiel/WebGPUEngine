import { vec3 } from 'gl-matrix'; // needed for wallNormal storage and raycast dir
import type { IMovementController } from './IMovementController';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { CharacterControllerComponentDataType } from '../../../types/CharacterControllerComponentData.type';

/**
 * WallKickSystem - Salto de impulso apoyado en una pared frontal.
 *
 * Mecánica: si el jugador está en el aire, mira una pared (raycast frontal la
 * detecta dentro de `detectionDistance`) y presiona JUMP, se impulsa en la
 * dirección opuesta a la pared con velocidad horizontal `kickHorizontalSpeed`
 * más el impulso vertical normal de salto.
 *
 * Solo puede activarse UNA vez por periodo aéreo; el token se resetea al
 * tocar el suelo (`onGrounded`).
 *
 * No interfiere con el wall run (ese tiene su propio salto) ni con el coyote
 * ground jump: se llama después de JumpSystem y WallRunSystem.checkCoyoteWallJump,
 * de modo que solo actúa si ningún sistema anterior consumió el input de salto.
 */
export class WallKickSystem {
  // ── Parámetros ────────────────────────────────────────────────────────────
  private detectionDistance: number = 0.8;
  private inputDisableTime: number = 0.15;

  // ── Estado interno ────────────────────────────────────────────────────────
  private wallKickAvailable: boolean = true;
  private wallNormal: vec3 = vec3.create();
  private isWallInFront: boolean = false;

  constructor(
    private controller: IMovementController,
    data: CharacterControllerComponentDataType,
  ) {
    this.detectionDistance = data.wallKickDetectionDistance ?? this.detectionDistance;
    this.inputDisableTime = data.wallKickInputDisableTime ?? this.inputDisableTime;
  }

  /**
   * Llamar desde el caso IDLE del controller, después de JumpSystem y
   * WallRunSystem.checkCoyoteWallJump.
   */
  public update(_deltaTime: number): void {
    this.detectWallInFront();

    if (!this.wallKickAvailable) return;
    if (this.controller.getIsGrounded()) return;
    if (!this.isWallInFront) return;

    const input = Engine.getInput();
    if (input.isActionBuffered(GameAction.JUMP)) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.applyWallKick();
    }
  }

  /**
   * Llanzar raycast hacia adelante (cámara frontal aplanado en XZ) y guardar
   * la normal de la pared si hay un cuerpo fijo en la distancia de detección.
   */
  private detectWallInFront(): void {
    this.isWallInFront = false;

    const camera = this.controller.getCamera();
    if (!camera) return;

    const facingVector = camera.getCamera().getFront();
    facingVector[1] = 0;
    vec3.normalize(facingVector, facingVector);

    const origin = this.controller.getCollider().getRigidBody().translation();
    const physics = Engine.getPhysics();

    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: facingVector[0], y: facingVector[1], z: facingVector[2] },
    );

    const hit = physics
      .getWorld()
      .castRayAndGetNormal(
        ray,
        this.detectionDistance,
        true,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.controller.getCollider().getCollider(),
      );

    if (hit && hit.collider && hit.collider.parent()!.bodyType() === RAPIER.RigidBodyType.Fixed) {
      this.isWallInFront = true;
      vec3.set(this.wallNormal, hit.normal.x, hit.normal.y, hit.normal.z);
    }
  }

  private applyWallKick(): void {
    this.wallKickAvailable = false;

    // Solo impulso vertical — es un salto hacia arriba apoyado en la pared.
    // La velocidad horizontal se conserva tal cual (el jugador mantiene su momentum).
    this.controller.applyJumpFromSystem();

    // Pequeña ventana de input desactivado para que el impulso sea limpio
    this.controller.setInputDisableTimer(this.inputDisableTime);
  }

  /**
   * Resetear el token de wall kick. Llamar cuando el jugador toca el suelo.
   */
  public onGrounded(): void {
    this.wallKickAvailable = true;
  }

  // ── Getters de estado (útiles para debug) ────────────────────────────────
  public getIsWallInFront(): boolean {
    return this.isWallInFront;
  }

  public getWallKickAvailable(): boolean {
    return this.wallKickAvailable;
  }
}
