import { Component } from '../../core/ecs/Component';
import { CombatDirectorComponentData } from '../../types/CombatDirectorComponentData.type';
import type { EnemyControllerComponent } from './EnemyControllerComponent';

/**
 * CombatDirectorComponent — Capa 3 del sistema de IA de combate.
 *
 * Gestiona el pool de tokens que controla qué enemigos pueden atacar a la vez.
 * Coloca este componente en cualquier entidad persistente de la escena (ej. "GameManager").
 *
 * Reglas del token system:
 *  - Un enemigo DEBE adquirir un token antes de entrar en su comportamiento de ataque.
 *  - Como máximo N enemigos pueden tener token simultáneamente (maxActiveAttackers).
 *  - El token se libera automáticamente cuando el enemigo pierde visión del jugador.
 *  - El token se libera en muerte.
 *  - Si no hay CombatDirectorComponent en la escena: todos los enemigos atacan (fallback).
 *
 * JSON:
 *  { "combat_director": { "maxActiveAttackers": 2 } }
 */
export class CombatDirectorComponent extends Component {
  /** Active director singleton. Set in load(), cleared in dispose(). */
  static instance: CombatDirectorComponent | null = null;

  private maxActiveAttackers: number = 2;
  private readonly tokenHolders = new Set<EnemyControllerComponent>();

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: CombatDirectorComponentData): void {
    this.maxActiveAttackers = data.maxActiveAttackers ?? 2;
    CombatDirectorComponent.instance = this;
  }

  // ─── Token API ─────────────────────────────────────────────────────────────

  /**
   * Try to grant a token to `enemy`.
   * Returns true if the token was granted or the enemy already holds one.
   */
  public acquireToken(enemy: EnemyControllerComponent): boolean {
    if (this.tokenHolders.has(enemy)) return true;
    if (this.tokenHolders.size >= this.maxActiveAttackers) return false;
    this.tokenHolders.add(enemy);
    return true;
  }

  /** Release the token held by `enemy`. No-op if they don't hold one. */
  public releaseToken(enemy: EnemyControllerComponent): void {
    this.tokenHolders.delete(enemy);
  }

  public hasToken(enemy: EnemyControllerComponent): boolean {
    return this.tokenHolders.has(enemy);
  }

  public getActiveAttackerCount(): number {
    return this.tokenHolders.size;
  }

  public getMaxActiveAttackers(): number {
    return this.maxActiveAttackers;
  }

  // ─── Boilerplate ───────────────────────────────────────────────────────────

  public update(_dt: number): void {}

  public override dispose(): void {
    if (CombatDirectorComponent.instance === this) {
      CombatDirectorComponent.instance = null;
    }
    this.tokenHolders.clear();
  }

  public renderDebug(): void {}

  public override renderInMenu(): void {}
}
