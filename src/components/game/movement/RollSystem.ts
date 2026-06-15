import { vec3 } from 'gl-matrix';
import type { IMovementController } from './IMovementController';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';

/**
 * RollSystem - Gestiona el roll y conversión de velocidad vertical
 */
export class RollSystem {
  // Parámetros del roll
  private rollDuration: number = 0.4;
  private rollSpeedMultiplier: number = 1.9;
  private rollCooldown: number = 0.5;
  private rollFallSpeedConversionFactor: number = 0.7;
  private rollLandingCacheWindow: number = 0.2;

  // Estado interno
  private rollSpeed: number = 0.0;
  private rollDirection: vec3 = vec3.create();
  private rollTimer: number = 0.0;
  private rollCooldownTimer: number = 0.0;
  private initialRollSpeed: number = 0.0;

  // Cacheo de caída
  private cachedFallSpeed: number = 0.0;
  private timeSinceLanded: number = 999.0;
  private wasGroundedLastFrame: boolean = false;

  constructor(
    private controller: IMovementController,
    private modifiers: PlayerModifiersComponent | null,
  ) {}

  /** @param inputDir Dirección WASD en espacio mundo (opcional). Si se provee, el roll va en esa dirección. */
  public update(deltaTime: number, inputDir?: vec3): void {
    if (this.rollCooldownTimer > 0.0) {
      this.rollCooldownTimer -= deltaTime;
    }

    this.updateFallCaching(deltaTime);

    const input = Engine.getInput();
    if (this.canStartRoll() && input.isActionBuffered(GameAction.ROLL)) {
      input.consumeBufferedAction(GameAction.ROLL);
      this.startRoll(inputDir);
    }
  }

  public updateRollMovement(deltaTime: number): vec3 {
    this.rollTimer += deltaTime;

    // Proyectar dirección sobre el suelo
    const groundNormal = this.controller.getGroundNormal();
    const projected = this.projectOnPlane(this.rollDirection, groundNormal);
    vec3.normalize(projected, projected);

    const result = vec3.scale(vec3.create(), this.rollDirection, this.rollSpeed);

    // Terminar roll si se acabó la duración o perdimos suelo
    if (this.rollTimer >= this.rollDuration || !this.controller.getIsGrounded()) {
      this.endRoll();
    }

    return result;
  }

  private canStartRoll(): boolean {
    return (
      !this.controller.getIsRolling() &&
      this.controller.getIsGrounded() &&
      this.rollCooldownTimer <= 0.0
    );
  }

  private startRoll(inputDir?: vec3): void {
    this.controller.setIsRolling(true);
    this.rollTimer = 0.0;

    const currentSpeed = this.controller.getCurrentSpeed();
    const currentHorizontalVel = this.controller.getHorizontalVelocity();

    // CONVERSIÓN DE VELOCIDAD VERTICAL A HORIZONTAL
    let verticalSpeedBonus = 0.0;
    if (this.timeSinceLanded <= this.rollLandingCacheWindow && this.cachedFallSpeed > 0) {
      verticalSpeedBonus = this.cachedFallSpeed * this.rollFallSpeedConversionFactor;
      this.cachedFallSpeed = 0.0;
    }

    // Calcular velocidad del roll
    this.initialRollSpeed = Math.max(currentSpeed + verticalSpeedBonus, 9.0);
    this.initialRollSpeed = Math.min(this.initialRollSpeed, 14.0);
    this.rollSpeed = this.initialRollSpeed * this.rollSpeedMultiplier;

    // Fijar dirección: WASD tiene prioridad, luego velocidad, luego cámara
    if (inputDir && vec3.length(inputDir) > 0.01) {
      this.rollDirection[0] = inputDir[0];
      this.rollDirection[1] = 0;
      this.rollDirection[2] = inputDir[2];
      vec3.normalize(this.rollDirection, this.rollDirection);
    } else if (currentSpeed > 0.01) {
      vec3.normalize(this.rollDirection, currentHorizontalVel);
    } else {
      const camera = this.controller.getCamera();
      if (camera) {
        const forward = camera.getCamera().getFront();
        this.rollDirection[0] = forward[0];
        this.rollDirection[1] = 0;
        this.rollDirection[2] = forward[2];
        vec3.normalize(this.rollDirection, this.rollDirection);
      }
    }
  }

  private endRoll(): void {
    if (!this.controller.getIsRolling()) return;

    this.controller.setIsRolling(false);
    this.rollTimer = 0.0;
    this.rollCooldownTimer = this.rollCooldown;

    // Transferir velocidad al controller
    const dir = vec3.normalize(vec3.create(), this.rollDirection);
    const newVelocity = vec3.scale(vec3.create(), dir, this.initialRollSpeed);
    this.controller.setHorizontalVelocity(newVelocity);

    // Setear boosted speed
    this.controller.setBoostedSpeed(this.initialRollSpeed);

    // Notificar modifiers
    this.modifiers?.notifyPerfectAction?.();
  }

  private updateFallCaching(deltaTime: number): void {
    const isGrounded = this.controller.getIsGrounded();
    const verticalVel = this.controller.getVerticalVelocity();

    // Cachear velocidad al aterrizar
    if (isGrounded && !this.wasGroundedLastFrame) {
      this.cachedFallSpeed = Math.max(0, -verticalVel);
      this.timeSinceLanded = 0.0;
    }

    this.wasGroundedLastFrame = isGrounded;

    // Actualizar timer y limpiar cache si pasó la ventana
    if (isGrounded) {
      this.timeSinceLanded += deltaTime;

      if (this.timeSinceLanded > this.rollLandingCacheWindow) {
        if (this.cachedFallSpeed > 0.0) {
          this.controller.setBoostedSpeed(0.0);
        }
        this.cachedFallSpeed = 0.0;
      }
    }
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }

  // Getters públicos
  public getRollTimer(): number {
    return this.rollTimer;
  }

  public getRollDuration(): number {
    return this.rollDuration;
  }
}
