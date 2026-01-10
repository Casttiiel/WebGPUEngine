import { vec3 } from 'gl-matrix';
import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { SwingEntryData } from '../../../types/SwingEntryData.type';

/**
 * SwingSystem - Gestiona el columpiarse en barras
 */
export class SwingSystem {
  // Parámetros de swing
  private minSwingSpeed: number = 6.0;

  // Estado interno
  private swingAxis: vec3 = vec3.create();
  private swingBase: vec3 = vec3.create();
  private swingTangent: vec3 = vec3.create();
  private swingRadius: number = 0;
  private swingAngle: number = 0;
  private swingSpeed: number = 0;
  private swingAngularSpeed: number = 0;
  private swingEndAngle: number = 0;
  private swingDirection: number = 1;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
  ) {}

  public startSwing(data: SwingEntryData): void {
    if (
      this.controller.getIsSwinging() ||
      (this.controller.getIsGrounded() && this.controller.getVerticalVelocity() <= 0.0) ||
      this.controller.getIsMantling()
    ) {
      return;
    }

    this.controller.setIsSwinging(true);
    this.controller.setIsDashing(false);

    this.swingAngle = data.startAngle;
    this.swingEndAngle = data.endAngle;
    this.swingDirection = data.direction;
    this.swingRadius = data.radius;
    vec3.copy(this.swingAxis, data.barAxis);

    this.swingSpeed = Math.max(this.controller.getCurrentSpeed(), this.minSwingSpeed);
    this.swingAngularSpeed = this.swingSpeed / this.swingRadius;

    const down = vec3.fromValues(0, -1, 0);
    vec3.copy(this.swingBase, this.projectOnPlane(down, this.swingAxis));
    vec3.normalize(this.swingBase, this.swingBase);

    vec3.cross(this.swingTangent, this.swingAxis, this.swingBase);
    vec3.normalize(this.swingTangent, this.swingTangent);

    if (this.swingDirection < 0) {
      vec3.scale(this.swingTangent, this.swingTangent, -1);
    }

    this.controller.setVerticalVelocity(0);
    this.controller.setIsJumping(false);
  }

  public updateSwingMovement(deltaTime: number): void {
    this.swingAngle += this.swingDirection * this.swingAngularSpeed * deltaTime;

    const finished =
      (this.swingDirection > 0 && this.swingAngle >= this.swingEndAngle) ||
      (this.swingDirection < 0 && this.swingAngle <= this.swingEndAngle);

    if (finished) {
      this.endSwing();
      return;
    }

    const radial = vec3.create();
    vec3.scale(radial, this.swingBase, Math.cos(this.swingAngle));
    vec3.scaleAndAdd(radial, radial, this.swingTangent, Math.sin(this.swingAngle));
    vec3.normalize(radial, radial);

    const velocityDir = vec3.cross(vec3.create(), this.swingAxis, radial);
    vec3.normalize(velocityDir, velocityDir);

    velocityDir[0] *= this.swingDirection;
    velocityDir[2] *= this.swingDirection;

    const newVel = vec3.scale(vec3.create(), velocityDir, this.swingSpeed);
    this.controller.setHorizontalVelocity(newVel);

    const horizontalVel = this.controller.getHorizontalVelocity();
    this.controller.setVerticalVelocity(horizontalVel[1]);
    horizontalVel[1] = 0;
    this.controller.setHorizontalVelocity(horizontalVel);
  }

  private endSwing(): void {
    this.controller.setIsSwinging(false);

    const verticalVel = Math.max(this.controller.getVerticalVelocity(), 1.5);
    this.controller.setVerticalVelocity(verticalVel);
    this.controller.setIsJumping(true);
  }

  private projectOnPlane(v: vec3, normal: vec3): vec3 {
    const dot = vec3.dot(v, normal);
    const projected = vec3.create();
    vec3.scaleAndAdd(projected, v, normal, -dot);
    return projected;
  }
}
