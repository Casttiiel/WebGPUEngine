import type { IAbility, AbilityContext } from './IAbility';
import { AbilityId } from '../../../types/AbilityId.enum';
import { AbilitySlot } from '../../../types/AbilitySlot.enum';

/**
 * AbilitySystem — Gestiona el registro de habilidades desbloqueadas
 * y los slots equipados por el jugador.
 *
 * Conceptos clave:
 *  - **Unlocked**: set de habilidades que el jugador ha obtenido.
 *    Se añaden mediante unlock() (progresión, loot, etc.).
 *  - **Equipped**: qué habilidad hay asignada a cada slot (Q/E/R).
 *    El jugador puede reasignar slots libremente entre las desbloqueadas.
 *
 * Un slot vacío (null) simplemente no hace nada al activarse.
 */
export class AbilitySystem {
  private unlocked = new Map<AbilityId, IAbility>();
  private slots = new Map<AbilitySlot, IAbility | null>([
    [AbilitySlot.Q, null],
    [AbilitySlot.E, null],
    [AbilitySlot.R, null],
  ]);

  // ──────────────────────────────────────────────
  // UNLOCK / EQUIP
  // ──────────────────────────────────────────────

  /**
   * Registra una habilidad como desbloqueada y la carga con el contexto del jugador.
   * Si ya estaba desbloqueada, la sobrescribe (útil para upgrades).
   */
  public async unlock(ability: IAbility, ctx: AbilityContext): Promise<void> {
    await ability.load(ctx);
    this.unlocked.set(ability.id, ability);
  }

  public isUnlocked(id: AbilityId): boolean {
    return this.unlocked.has(id);
  }

  /**
   * Equipa una habilidad desbloqueada en un slot.
   * Devuelve false si la habilidad no está desbloqueada todavía.
   */
  public equip(slot: AbilitySlot, id: AbilityId): boolean {
    const ability = this.unlocked.get(id);
    if (!ability) return false;
    this.slots.set(slot, ability);
    return true;
  }

  public unequip(slot: AbilitySlot): void {
    this.slots.set(slot, null);
  }

  public getEquipped(slot: AbilitySlot): IAbility | null {
    return this.slots.get(slot) ?? null;
  }

  // ──────────────────────────────────────────────
  // ACTIVACIÓN
  // ──────────────────────────────────────────────

  /** Activa la habilidad del slot si puede activarse. */
  public activateSlot(slot: AbilitySlot): void {
    const ability = this.slots.get(slot);
    if (ability?.canActivate()) {
      ability.activate();
    }
  }

  /** Desactiva la habilidad del slot (soltar tecla, interrupción). */
  public deactivateSlot(slot: AbilitySlot): void {
    this.slots.get(slot)?.deactivate();
  }

  // ──────────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────────

  public update(dt: number): void {
    for (const ability of this.slots.values()) {
      ability?.update(dt);
    }
  }

  public dispose(): void {
    for (const ability of this.unlocked.values()) {
      ability.dispose();
    }
    this.unlocked.clear();
  }
}
