import type { IAbility, AbilityContext } from './IAbility';
import { AbilityId } from '../../../types/AbilityId.enum';

/**
 * PushAbility — Empuja objetos y enemigos en la dirección de la cámara.
 * TODO: Implementar raycast / overlap desde la cámara, aplicar impulso
 *       a rigidbodies en el área de efecto, reproducir VFX.
 */
export class PushAbility implements IAbility {
  public readonly id = AbilityId.PUSH;

  private cooldownTimer: number = 0;
  private readonly cooldown: number = 1.5;
  private readonly pushRadius: number = 4.0;
  private readonly pushForce: number = 20.0;

  private _ctx!: AbilityContext;

  public async load(ctx: AbilityContext): Promise<void> {
    this._ctx = ctx;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }
  }

  public canActivate(): boolean {
    return this.cooldownTimer <= 0;
  }

  public activate(): void {
    if (!this.canActivate()) return;
    this.cooldownTimer = this.cooldown;
    this.executePush();
  }

  public deactivate(): void {
    // Push es instantáneo, no requiere deactivate
  }

  private executePush(): void {
    // TODO: overlap sphere desde posición del jugador con radio pushRadius,
    //       aplicar impulso de pushForce en dirección cámara-forward a cada hit.
    void this._ctx;
    void this.pushRadius;
    void this.pushForce;
  }

  public dispose(): void {
    // TODO: limpiar recursos GPU / VFX
  }
}
