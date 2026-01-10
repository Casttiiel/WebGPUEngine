import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';

/**
 * MovementSystem - Gestiona movimiento horizontal en suelo y aire
 */
export class MovementSystem {
  // Parámetros de movimiento
  private runSpeed: number = 9.0;
  private maxSpeed: number = 14.0;
  private boostedSpeedDecayRate: number = 4.0;
  private groundAcceleration: number = 36.0;
  private groundDeceleration: number = 18.0;
  private airControl: number = 0.65;
  private airDrag: number = 0.1;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  public update(deltaTime: number, targetMovement: vec3): void {
    const hasInput = vec3.length(targetMovement) > 0.01;

    if (this.controller.getIsGrounded()) {
      this.updateGroundMovement(deltaTime, targetMovement, hasInput);
    } else {
      this.updateAirMovement(deltaTime, targetMovement, hasInput);
    }
  }

  private updateGroundMovement(deltaTime: number, targetMovement: vec3, hasInput: boolean): void {
    if (!hasInput) {
      const currentVel = this.controller.getHorizontalVelocity();
      targetMovement = vec3.normalize(vec3.create(), currentVel);
      // Perder velocidad boosted si te paras
      this.controller.setBoostedSpeed(0.0);
    }

    const currentSpeed = this.controller.getCurrentSpeed();
    const boostedSpeed = this.controller.getBoostedSpeed();

    // Decaer velocidad boosted gradualmente hacia runSpeed
    if (boostedSpeed > this.runSpeed) {
      const newBoostedSpeed = Math.max(
        this.runSpeed,
        boostedSpeed - this.boostedSpeedDecayRate * deltaTime,
      );
      this.controller.setBoostedSpeed(newBoostedSpeed);
    }

    // Velocidad objetivo: usar boostedSpeed si es mayor que runSpeed
    const baseTargetSpeed = hasInput ? Math.max(this.runSpeed, boostedSpeed) : 0.0;
    const targetSpeed = hasInput ? baseTargetSpeed : 0.0;
    const accel = hasInput ? this.groundAcceleration : this.groundDeceleration;
    const newSpeed = this.approach(currentSpeed, targetSpeed, accel * deltaTime);

    const newVelocity = vec3.scale(vec3.create(), targetMovement, newSpeed);
    this.controller.setHorizontalVelocity(newVelocity);
  }

  private updateAirMovement(deltaTime: number, targetMovement: vec3, hasInput: boolean): void {
    if (hasInput) {
      const boostedSpeed = this.controller.getBoostedSpeed();
      const baseTargetSpeed = Math.max(this.runSpeed, boostedSpeed);
      vec3.scale(targetMovement, targetMovement, baseTargetSpeed);

      const disabler = this.controller.isInputDisabled() ? 0.25 : 1.0;
      const airAcceleration = this.groundAcceleration * this.airControl * disabler;

      const currentVel = this.controller.getHorizontalVelocity();
      const newVel = vec3.create();
      newVel[0] = this.approach(currentVel[0], targetMovement[0], airAcceleration * deltaTime);
      newVel[1] = currentVel[1];
      newVel[2] = this.approach(currentVel[2], targetMovement[2], airAcceleration * deltaTime);

      this.controller.setHorizontalVelocity(newVel);
    } else {
      // Sin input: aplicar resistencia del aire
      const dragFactor = Math.pow(1.0 - this.airDrag, deltaTime);
      const currentVel = this.controller.getHorizontalVelocity();
      vec3.scale(currentVel, currentVel, dragFactor);
      this.controller.setHorizontalVelocity(currentVel);
    }
  }

  private approach(current: number, target: number, delta: number): number {
    if (current < target) {
      return Math.min(current + delta, target);
    }
    if (current > target) {
      return Math.max(current - delta, target);
    }
    return target;
  }

  // Getters públicos
  public getRunSpeed(): number {
    return this.runSpeed;
  }

  public getMaxSpeed(): number {
    return this.maxSpeed;
  }
}
