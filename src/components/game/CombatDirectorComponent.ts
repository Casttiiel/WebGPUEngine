import { Component } from '../../core/ecs/Component';
import { CombatDirectorComponentData } from '../../types/CombatDirectorComponentData.type';
import { CombatEventBus } from '../../ai/CombatEventBus';
import { EnemyRole } from '../../types/EnemyRole.enum';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import type { EnemyControllerComponent } from './EnemyControllerComponent';

/**
 * CombatDirectorComponent — Capa 3 del sistema de IA de combate (Bloque 1 + 6).
 *
 * Gestiona:
 *  - Token system: pool de N atacantes simultáneos.
 *  - Asignación de roles (AGGRESSOR / FLANKER / HARASSER / SUPPORT).
 *  - Escalado de presión cuando el jugador no recibe daño durante N segundos.
 *
 * Presión escalonada:
 *  - +8 s sin dañar al jugador → maxActiveAttackers += 1
 *  - +15 s sin dañar al jugador → maxActiveAttackers += 2 y todos los HARASSER → AGGRESSOR
 *  - Jugador recibe daño → timer se resetea al instante (via CombatEventBus 'player_damaged')
 *
 * Roles:
 *  El primer enemigo que adquiere token recibe rol AGGRESSOR.
 *  El segundo recibe FLANKER — el algoritmo de sectores de CircleStrafeAction
 *  ya lo dirige naturalmente hacia el lado opuesto sin lógica adicional.
 *
 * JSON:
 *  { "combat_director": { "maxActiveAttackers": 2 } }
 */
export class CombatDirectorComponent extends Component {
  /** Active director singleton. Set in load(), cleared in dispose(). */
  static instance: CombatDirectorComponent | null = null;

  private maxActiveAttackers: number = 2;
  private _baseMaxAttackers: number = 2;
  private readonly tokenHolders = new Set<EnemyControllerComponent>();

  // ── Roles ────────────────────────────────────────────────────────────────────
  private readonly _roles = new Map<EnemyControllerComponent, EnemyRole>();

  // ── Pressure escalation ──────────────────────────────────────────────────────
  private _timeSincePlayerDamaged: number = 0;
  private _unsub: Array<() => void> = [];

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: CombatDirectorComponentData): void {
    this.maxActiveAttackers = data.maxActiveAttackers ?? 2;
    this._baseMaxAttackers = this.maxActiveAttackers;
    CombatDirectorComponent.instance = this;

    this._unsub.push(
      CombatEventBus.on('player_damaged', () => {
        this._timeSincePlayerDamaged = 0;
      }),
    );
  }

  // ─── Token API ─────────────────────────────────────────────────────────────

  /**
   * Try to grant a token to `enemy`.
   * The first token holder receives AGGRESSOR, the second FLANKER.
   */
  public acquireToken(enemy: EnemyControllerComponent): boolean {
    if (this.tokenHolders.has(enemy)) return true;
    if (this.tokenHolders.size >= this.maxActiveAttackers) return false;
    this.tokenHolders.add(enemy);

    // Auto role assignment on first token acquisition
    if (!this._roles.has(enemy)) {
      const role = this.tokenHolders.size === 1 ? EnemyRole.AGGRESSOR : EnemyRole.FLANKER;
      this._roles.set(enemy, role);
    }

    return true;
  }

  /** Release the token held by `enemy`. No-op if they don't hold one. */
  public releaseToken(enemy: EnemyControllerComponent): void {
    this.tokenHolders.delete(enemy);
    // Clear dynamic role so next token acquisition re-evaluates
    this._roles.delete(enemy);
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

  // ─── Role API ──────────────────────────────────────────────────────────────

  /** Assign a role manually (e.g. ranger always starts as HARASSER). */
  public assignRole(enemy: EnemyControllerComponent, role: EnemyRole): void {
    this._roles.set(enemy, role);
  }

  /** Returns the current role of `enemy`, defaulting to AGGRESSOR. */
  public getRole(enemy: EnemyControllerComponent): EnemyRole {
    return this._roles.get(enemy) ?? EnemyRole.AGGRESSOR;
  }

  // ─── Pressure escalation ────────────────────────────────────────────────────

  public update(dt: number): void {
    this._timeSincePlayerDamaged += dt;

    // maxActiveAttackers is naturally capped by the number of living enemies:
    // extra tokens beyond active enemies simply never get claimed.
    if (this._timeSincePlayerDamaged > 15) {
      this.maxActiveAttackers = this._baseMaxAttackers + 2;
      for (const [enemy, role] of this._roles) {
        if (role === EnemyRole.HARASSER) {
          this._roles.set(enemy, EnemyRole.AGGRESSOR);
        }
      }
    } else if (this._timeSincePlayerDamaged > 8) {
      this.maxActiveAttackers = this._baseMaxAttackers + 1;
    } else {
      this.maxActiveAttackers = this._baseMaxAttackers;
    }
  }

  // ─── Static registration ────────────────────────────────────────────────────

  /**
   * Bridges MsgDispatcher → CombatEventBus for player damage events.
   * Must be called once from Engine.registerAllMsgs().
   */
  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DAMAGED, 'player_controller', (_comp) => {
      CombatEventBus.emit('player_damaged');
    });
  }

  // ─── Boilerplate ───────────────────────────────────────────────────────────

  public override dispose(): void {
    if (CombatDirectorComponent.instance === this) {
      CombatDirectorComponent.instance = null;
    }
    this.tokenHolders.clear();
    this._roles.clear();
    for (const u of this._unsub) u();
    this._unsub.length = 0;
  }

  public renderDebug(): void {}
  public override renderInMenu(): void {}
}
