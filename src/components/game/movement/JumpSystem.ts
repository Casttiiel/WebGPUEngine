import type { CharacterControllerComponent } from '../CharacterControllerComponent';
import type { PlayerModifiersComponent } from '../PlayerModifiersComponent';
import { Engine } from '../../../core/engine/Engine';
import { GameAction } from '../../../types/GameAction.enum';
import { CharacterControllerComponentDataType } from '../../../types/CharacterControllerComponentData.type';

/**
 * JumpSystem - Gestiona saltos y gravedad
 */
export class JumpSystem {
  // Parámetros de salto
  private jumpHeight: number = 2.2;
  private jumpTimeToPeak: number = 0.5;
  private jumpTimeToDescent: number = 0.4;
  private jumpCutFactor: number = 0.7;
  private coyoteTime: number = 0.12;
  private jumpCutVerticalVelocityLimit: number = 0.25;

  private jumpVelocity: number = 0.0;
  private jumpGravity: number = 0.0;
  private fallGravity: number = 0.0;
  private timeSinceGrounded: number = 0.0;
  private wallRunGravity: number = -2.0;

  constructor(
    private controller: CharacterControllerComponent,
    private _modifiers: PlayerModifiersComponent | null,
    data: CharacterControllerComponentDataType,
  ) {
    this.jumpHeight = data.jumpHeight ?? this.jumpHeight;
    this.jumpTimeToPeak = data.jumpTimeToPeak ?? this.jumpTimeToPeak;
    this.jumpTimeToDescent = data.jumpTimeToDescent ?? this.jumpTimeToDescent;
    this.jumpCutFactor = data.jumpCutFactor ?? this.jumpCutFactor;
    this.coyoteTime = data.coyoteTime ?? this.coyoteTime;
    this.jumpCutVerticalVelocityLimit =
      data.jumpCutVerticalVelocityLimit ?? this.jumpCutVerticalVelocityLimit;
    this.wallRunGravity = data.wallRunGravity ?? this.wallRunGravity;

    this.calculatePhysicsConstants();
  }

  private calculatePhysicsConstants(): void {
    this.jumpVelocity = (2.0 * this.jumpHeight) / this.jumpTimeToPeak;
    this.jumpGravity = (-2.0 * this.jumpHeight) / (this.jumpTimeToPeak * this.jumpTimeToPeak);
    this.fallGravity = (-2.0 * this.jumpHeight) / (this.jumpTimeToDescent * this.jumpTimeToDescent);
  }

  public update(deltaTime: number): void {
    this.applyGravity(deltaTime);
    this.manageJump(deltaTime);
  }

  private applyGravity(deltaTime: number): void {
    if (!this.controller.getIsGrounded()) {
      const verticalVel = this.controller.getVerticalVelocity();
      const gravity = verticalVel > 0 ? this.jumpGravity : this.fallGravity;

      // Gravedad especial durante wallrun
      const finalGravity = this.controller.getIsWallRunning() ? this.wallRunGravity : gravity;

      const jumpCutFactor =
        this.controller.getIsJumping() &&
        !this.controller.getIsWallRunning() &&
        Math.abs(verticalVel) > 0 &&
        Math.abs(verticalVel) < this.jumpCutVerticalVelocityLimit
          ? this.jumpCutFactor
          : 1.0;

      const newVerticalVel = verticalVel + finalGravity * jumpCutFactor * deltaTime;
      this.controller.setVerticalVelocity(newVerticalVel);
    } else if (this.controller.getIsGrounded() && !this.controller.getIsJumping()) {
      this.controller.setVerticalVelocity(0.0);
    }
  }

  private manageJump(deltaTime: number): void {
    const input = Engine.getInput();
    const canGroundJump =
      !this.controller.getIsJumping() &&
      (this.timeSinceGrounded <= this.coyoteTime || this.controller.getIsGrounded());

    // Update coyote time
    if (this.controller.getIsGrounded() && !this.controller.getIsJumping()) {
      this.timeSinceGrounded = 0.0;
    } else {
      this.timeSinceGrounded += deltaTime;
    }

    // Detectar inicio del salto
    if (input.isActionBuffered(GameAction.JUMP) && canGroundJump) {
      input.consumeBufferedAction(GameAction.JUMP);
      this.applyJump(this.jumpVelocity);
    } else if (
      this.controller.getIsJumping() &&
      Math.abs(this.controller.getVerticalVelocity()) > this.jumpCutVerticalVelocityLimit &&
      this.controller.getVerticalVelocity() < 0.0
    ) {
      this.controller.setIsJumping(false);
    }
  }

  public applyJump(jumpForce: number): void {
    this.controller.setVerticalVelocity(jumpForce);
    this.controller.setIsJumping(true);
    this.timeSinceGrounded = this.coyoteTime + 1.0;
  }

  public getJumpVelocity(): number {
    return this.jumpVelocity;
  }

  public getJumpGravity(): number {
    return this.jumpGravity;
  }
}
