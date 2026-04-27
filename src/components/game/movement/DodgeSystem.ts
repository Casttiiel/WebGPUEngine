import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import type { StaminaComponent } from '../StaminaComponent';

export interface DodgeSystemData {
  dodgeSpeed?: number;
  dodgeDuration?: number;
  dodgeCooldown?: number;
  dodgeStaminaCost?: number; // Stamina cost per dodge (default: 0 = free)
}

/**
 * DodgeSystem — Esquiva corta en la dirección del input (o hacia adelante si no hay input).
 * Solo se activa si el personaje está en el suelo.
 * Input: GameAction.ROLL (SHIFT).
 */
export class DodgeSystem {
  private dodgeSpeed: number;
  private dodgeDuration: number;
  private dodgeCooldown: number;
  private staminaCost: number;

  private dodgeTimer: number = 0.0;
  private cooldownTimer: number = 0.0;
  private dodgeDirection: vec3 = vec3.create();

  constructor(
    private controller: IMovementController,
    data: DodgeSystemData,
    private getStamina: (() => StaminaComponent | null) | null = null,
  ) {
    this.dodgeSpeed = data.dodgeSpeed ?? 16.0;
    this.dodgeDuration = data.dodgeDuration ?? 0.2;
    this.dodgeCooldown = data.dodgeCooldown ?? 0.8;
    this.staminaCost = data.dodgeStaminaCost ?? 20;
  }

  /**
   * Debe llamarse cada frame, antes del switch de movimiento.
   * Si el estado es DODGING, gestiona el timer y termina la esquiva cuando expira.
   * Si el estado es IDLE y el jugador pulsa SHIFT en el suelo, inicia la esquiva.
   */
  public update(deltaTime: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= deltaTime;
    }

    if (this.controller.getIsDodging()) {
      this.dodgeTimer -= deltaTime;
      if (this.dodgeTimer <= 0) {
        this.endDodge();
      }
      return;
    }

    // Detectar trigger solo desde estado normal y en el suelo
    if (!this.controller.getIsGrounded()) return;
    if (this.cooldownTimer > 0) return;
    if (
      this.controller.getIsMantling() ||
      this.controller.getIsSwinging() ||
      this.controller.getIsDashing()
    )
      return;

    const input = Engine.getInput();
    if (!input.isActionJustPressed(GameAction.ROLL)) return;

    this.startDodge();
  }

  /** Retorna la velocidad de dodge como vec3 (Y = 0, solo movimiento horizontal). */
  public getDodgeVelocity(): vec3 {
    return vec3.scale(vec3.create(), this.dodgeDirection, this.dodgeSpeed);
  }

  private startDodge(): void {
    // Comprobar y gastar stamina antes de ejecutar (lazy lookup)
    const stamina = this.getStamina ? this.getStamina() : null;
    if (this.staminaCost > 0 && stamina !== null) {
      if (!stamina.spend(this.staminaCost)) return;
    }

    const dir = this.computeDodgeDirection();
    vec3.copy(this.dodgeDirection, dir);

    this.controller.setIsDodging(true);
    this.controller.setVerticalVelocity(0.0);
    this.dodgeTimer = this.dodgeDuration;
    this.cooldownTimer = this.dodgeCooldown;
  }

  private endDodge(): void {
    this.controller.setIsDodging(false);
    // Mantener un poco de inercia al salir del dodge
    const exitVel = vec3.scale(vec3.create(), this.dodgeDirection, this.dodgeSpeed * 0.25);
    this.controller.setHorizontalVelocity(exitVel);
  }

  private computeDodgeDirection(): vec3 {
    const camera = this.controller.getCamera();
    if (!camera) return vec3.fromValues(0, 0, -1);

    const forward = camera.getCamera().getFront();
    const up = vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), up, forward));
    const forwardXZ = vec3.normalize(vec3.create(), vec3.fromValues(forward[0], 0, forward[2]));
    const rightXZ = vec3.normalize(vec3.create(), vec3.fromValues(right[0], 0, right[2]));

    const input = Engine.getInput();
    let ix = 0;
    let iz = 0;
    if (input.isActionPressed(GameAction.MOVE_FORWARD)) iz -= 1;
    if (input.isActionPressed(GameAction.MOVE_BACKWARD)) iz += 1;
    if (input.isActionPressed(GameAction.MOVE_LEFT)) ix -= 1;
    if (input.isActionPressed(GameAction.MOVE_RIGHT)) ix += 1;

    if (Math.abs(ix) < 0.01 && Math.abs(iz) < 0.01) {
      // Sin input → hacia adelante (donde mira la cámara)
      return forwardXZ;
    }

    const fwd = vec3.scale(vec3.create(), forwardXZ, -iz);
    const rgt = vec3.scale(vec3.create(), rightXZ, -ix);
    const dir = vec3.add(vec3.create(), fwd, rgt);
    return vec3.normalize(dir, dir);
  }

  public getCooldownRatio(): number {
    return Math.max(0, this.cooldownTimer / this.dodgeCooldown);
  }

  public isOnCooldown(): boolean {
    return this.cooldownTimer > 0;
  }
}
