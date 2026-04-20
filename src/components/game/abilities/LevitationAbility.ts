import type { IAbility, AbilityContext } from './IAbility';
import { AbilityId } from '../../../types/AbilityId.enum';

/**
 * LevitationAbility — Permite al jugador levitar / flotar.
 * TODO: Implementar lógica de levitación (modificar gravedad del controller,
 *       reproducir VFX de levitación, consumir stamina/mana).
 */
export class LevitationAbility implements IAbility {
  public readonly id = AbilityId.LEVITATION;

  private _isActive: boolean = false;
  private cooldownTimer: number = 0;
  private readonly cooldown: number = 2.0;

  private _ctx!: AbilityContext;

  public async load(ctx: AbilityContext): Promise<void> {
    this._ctx = ctx;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }
    // TODO: aplicar fuerza anti-gravedad mientras esté activo
    void this._ctx;
  }

  public canActivate(): boolean {
    return this.cooldownTimer <= 0;
  }

  public activate(): void {
    if (!this.canActivate()) return;
    this._isActive = true;
    // TODO: iniciar levitación
  }

  public deactivate(): void {
    if (!this._isActive) return;
    this._isActive = false;
    this.cooldownTimer = this.cooldown;
    // TODO: terminar levitación
  }

  public dispose(): void {
    // TODO: limpiar recursos GPU / VFX
  }
}
