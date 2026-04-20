import type { IAbility, AbilityContext } from './IAbility';
import { AbilityId } from '../../../types/AbilityId.enum';

/**
 * SpawnChainAbility — Invoca una cadena que ata o ancla objetos/enemigos.
 * TODO: Implementar targeting, spawning de la entidad cadena,
 *       lógica de anclaje a rigidbodies, duración y cleanup.
 */
export class SpawnChainAbility implements IAbility {
  public readonly id = AbilityId.SPAWN_CHAIN;

  private cooldownTimer: number = 0;
  private readonly cooldown: number = 4.0;
  private readonly chainDuration: number = 5.0;
  private activeChainTimer: number = 0;

  private _ctx!: AbilityContext;

  public async load(ctx: AbilityContext): Promise<void> {
    this._ctx = ctx;
  }

  public update(dt: number): void {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }
    if (this.activeChainTimer > 0) {
      this.activeChainTimer -= dt;
      if (this.activeChainTimer <= 0) {
        this.despawnChain();
      }
    }
  }

  public canActivate(): boolean {
    return this.cooldownTimer <= 0 && this.activeChainTimer <= 0;
  }

  public activate(): void {
    if (!this.canActivate()) return;
    this.activeChainTimer = this.chainDuration;
    this.spawnChain();
  }

  public deactivate(): void {
    if (this.activeChainTimer > 0) {
      this.activeChainTimer = 0;
      this.despawnChain();
    }
  }

  private spawnChain(): void {
    // TODO: raycast desde cámara para encontrar target, crear entidad cadena,
    //       aplicar joint constraint al rigidbody del target.
    void this._ctx;
  }

  private despawnChain(): void {
    this.cooldownTimer = this.cooldown;
    // TODO: destruir entidad cadena y liberar constraint.
  }

  public dispose(): void {
    this.despawnChain();
    // TODO: limpiar recursos GPU / VFX
  }
}
