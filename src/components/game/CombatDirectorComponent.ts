import { Component } from '../../core/ecs/Component';
import { CombatDirectorComponentData } from '../../types/CombatDirectorComponentData.type';
import { CombatEventBus } from '../../ai/CombatEventBus';
import { EnemyRole } from '../../types/EnemyRole.enum';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { vec3 } from 'gl-matrix';

/**
 * CombatDirectorComponent — Orquestador global de combate H&S.
 *
 * Responsabilidades:
 *  1. Token pool — solo N enemigos pueden atacar simultáneamente.
 *  2. Pace timer — entre ciclos de ataque hay un silencio mínimo controlado
 *     aquí, NO en cada enemigo individual. Esto da el ritmo de combate.
 *  3. Agresividad — un dial 0→1 que escala maxActiveAttackers y se auto-incrementa
 *     cuando el jugador lleva tiempo sin recibir daño. Se resetea al golpearle.
 *  4. Roles — AGGRESSOR / FLANKER / HARASSER asignados en la adquisición del token.
 *
 * Flujo de ataque (H&S estándar):
 *   Enemigo listo → pide token → director comprueba:
 *     a. ¿Hay hueco en el pool? (tokenHolders.size < maxActiveAttackers)
 *     b. ¿Ha pasado el pace timer desde el último ciclo completo?
 *   Si pasa: concede token → enemigo ataca → suelta token →
 *   director anota timestamp → siguiente solicitud espera attackPaceMs.
 *
 * JSON:
 *  {
 *    "combat_director": {
 *      "aggressiveness": 0.5,
 *      "baseMaxAttackers": 1,
 *      "attackPaceMs": 1500
 *    }
 *  }
 */
export class CombatDirectorComponent extends Component {
  /** Active director singleton. */
  static instance: CombatDirectorComponent | null = null;

  // ── Public tunables (dat.GUI) ─────────────────────────────────────────────
  /**
   * 0 = muy pasivo (una oleada cada 3 s, 1 atacante).
   * 1 = implacable (oleada cada 0.3 s, 3 atacantes simultáneos).
   * Auto-escala si el jugador no recibe daño.
   */
  public aggressiveness: number = 0.5;

  /**
   * Pausa en ms entre el fin de un ciclo de ataque y el inicio del siguiente.
   * Independiente de la agresividad — permite control fino del ritmo.
   */
  public attackPaceMs: number = 1500;

  // ── Config ────────────────────────────────────────────────────────────────
  private _baseMaxAttackers: number = 1;
  private _baseAggressiveness: number = 0.5;

  // ── Token pool ────────────────────────────────────────────────────────────
  private readonly tokenHolders = new Set<EnemyControllerComponent>();

  // ── Pace timer ────────────────────────────────────────────────────────────
  // Timestamp (ms, Date.now()) before which no NEW attack wave can start.
  private _nextAttackAllowedAt: number = 0;

  /**
   * Score penalty applied to the enemy that most recently released a token.
   * Reduces their probability of being selected again immediately after attacking,
   * giving other enemies a better chance. If all others are ineligible, the
   * penalty is overcome naturally by the recently-attacked enemy's wait score
   * (timeSinceLastAttack × 10) growing each second.
   * Default 60 ≈ 6 seconds of wait-time advantage for competitors.
   */
  public lastAttackerPenalty: number = 60;

  // Tracks who most recently released a token — receives the score penalty.
  private _lastReleaser: EnemyControllerComponent | null = null;

  // ── Roles ─────────────────────────────────────────────────────────────────
  private readonly _roles = new Map<EnemyControllerComponent, EnemyRole>();

  // ── Pressure escalation ────────────────────────────────────────────────────
  private _timeSincePlayerDamaged: number = 0;
  private _unsub: Array<() => void> = [];

  // ── Editor ────────────────────────────────────────────────────────────────
  private _editorFolder: any = null;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: CombatDirectorComponentData): void {
    this._baseMaxAttackers = data.baseMaxAttackers ?? 1;
    this._baseAggressiveness = data.aggressiveness ?? 0.5;
    this.aggressiveness = this._baseAggressiveness;
    this.attackPaceMs = data.attackPaceMs ?? 1500;

    CombatDirectorComponent.instance = this;

    this._unsub.push(
      CombatEventBus.on('player_damaged', () => {
        this._timeSincePlayerDamaged = 0;
        // Snap back to base aggressiveness when player is hit
        this.aggressiveness = this._baseAggressiveness;
      }),
    );
  }

  // ─── Derived values ────────────────────────────────────────────────────────

  /**
   * Maximum simultaneous attackers, derived from aggressiveness.
   * aggressiveness=0 → baseMaxAttackers, aggressiveness=1 → baseMaxAttackers+2.
   */
  public getMaxActiveAttackers(): number {
    return Math.max(1, Math.round(this._baseMaxAttackers + this.aggressiveness * 2));
  }

  // ─── Token API ─────────────────────────────────────────────────────────────

  /**
   * Try to grant an attack token to `enemy`.
   * Gates on:
   *  a. Pool capacity (derived from aggressiveness).
   *  b. Pace timer: only the FIRST token of a new wave must wait.
   *     If tokens are already active, additional attackers (up to maxActive) join freely.
   */
  public acquireToken(enemy: EnemyControllerComponent): boolean {
    if (this.tokenHolders.has(enemy)) return true;

    const maxActive = this.getMaxActiveAttackers();
    if (this.tokenHolders.size >= maxActive) return false;

    // Pace gate: if the pool is empty (new wave), respect the inter-wave pause.
    if (this.tokenHolders.size === 0 && Date.now() < this._nextAttackAllowedAt) {
      return false;
    }

    this.tokenHolders.add(enemy);
    this._assignRole(enemy);
    return true;
  }

  /** Release the token held by `enemy`. Starts the pace timer when pool empties. */
  public releaseToken(enemy: EnemyControllerComponent): void {
    if (!this.tokenHolders.has(enemy)) return;
    this.tokenHolders.delete(enemy);
    this._roles.delete(enemy);
    this._lastReleaser = enemy;

    // When the last attacker finishes, start the inter-wave pause.
    if (this.tokenHolders.size === 0) {
      this._nextAttackAllowedAt = Date.now() + this.attackPaceMs;
    }
  }

  public hasToken(enemy: EnemyControllerComponent): boolean {
    return this.tokenHolders.has(enemy);
  }

  public getActiveAttackerCount(): number {
    return this.tokenHolders.size;
  }

  // ─── Role API ──────────────────────────────────────────────────────────────

  /** Returns the current role of `enemy`, defaulting to AGGRESSOR. */
  public getRole(enemy: EnemyControllerComponent): EnemyRole {
    return this._roles.get(enemy) ?? EnemyRole.AGGRESSOR;
  }

  /** Assign a role manually (e.g. ranged enemy → always HARASSER). */
  public assignRole(enemy: EnemyControllerComponent, role: EnemyRole): void {
    this._roles.set(enemy, role);
  }

  private _assignRole(enemy: EnemyControllerComponent): void {
    if (this._roles.has(enemy)) return;
    // First token holder → AGGRESSOR, second → FLANKER (CircleStrafeAction
    // sector algorithm naturally drives flankers to the opposite side).
    const role = this.tokenHolders.size === 1 ? EnemyRole.AGGRESSOR : EnemyRole.FLANKER;
    this._roles.set(enemy, role);
  }

  // ─── Pressure escalation ────────────────────────────────────────────────────

  public update(dt: number): void {
    this._timeSincePlayerDamaged += dt;

    // Aggressiveness climbs slowly when the player isn't being hit.
    // Resets to base on player_damaged (handled in load() subscription).
    const pressureGain = this._timeSincePlayerDamaged / 30; // reaches +1 after 30 s unhit
    this.aggressiveness = Math.min(1, this._baseAggressiveness + pressureGain);

    // ── Priority-based token grant ───────────────────────────────────────────
    // Director actively selects the best candidate(s) each frame so token
    // assignment is score-driven (distance + wait time) rather than first-come.
    // Enemies still call tryAcquireAttackToken() in their BT, which short-circuits
    // to true if the director already placed them in tokenHolders here.
    const maxActive = this.getMaxActiveAttackers();
    if (this.tokenHolders.size < maxActive && Date.now() >= this._nextAttackAllowedAt) {
      const candidates = ([...EnemyControllerComponent.getAll()] as EnemyControllerComponent[])
        .filter(e =>
          !this.tokenHolders.has(e) &&
          !e.isOnIndividualCooldown() &&
          e.bb.get<boolean>('canSeePlayer', false),
        )
        .sort((a, b) => this._score(b) - this._score(a));

      for (const e of candidates) {
        if (this.tokenHolders.size >= maxActive) break;
        this.tokenHolders.add(e);
        this._assignRole(e);
      }
    }
  }

  /**
   * Priority score for director-based token selection.
   * Higher score = picked first.
   *   Distance component: closer enemies get up to 150 pts (max at 0 m).
   *   Wait component: 10 pts per second since last attack (rewards patience).
   */
  private _score(e: EnemyControllerComponent): number {
    const pos = e.bb.get<vec3>('position');
    const playerPos = e.bb.get<vec3>('playerPosition');
    const distScore = pos && playerPos
      ? Math.max(0, 30 - vec3.distance(pos, playerPos)) * 5
      : 0;
    const waitScore = e.getTimeSinceLastAttack() * 10;
    // Soft penalty for the most recent attacker — fades as their wait time grows.
    // Once waitScore gains more than lastAttackerPenalty (≈6 s at ×10), they're
    // back in full contention if no better candidate exists.
    const recencyPenalty = e === this._lastReleaser ? -this.lastAttackerPenalty : 0;
    return distScore + waitScore + recencyPenalty;
  }

  // ─── Editor GUI ────────────────────────────────────────────────────────────

  public override renderInMenu(folder?: any): void {
    if (this._editorFolder || !folder) return;
    this._editorFolder = folder.addFolder('Combat Director');
    this._editorFolder.open();

    this._editorFolder
      .add(this, 'aggressiveness', 0, 1, 0.05)
      .name('Aggressiveness')
      .listen();

    this._editorFolder
      .add(this, 'attackPaceMs', 100, 5000, 50)
      .name('Attack pace (ms)')
      .listen();

    this._editorFolder
      .add(this, '_baseMaxAttackers', 1, 4, 1)
      .name('Base max attackers')
      .listen()
      .onChange(() => { /* derived value, no rebuild needed */ });

    this._editorFolder
      .add(this, 'lastAttackerPenalty', 0, 200, 5)
      .name('Last-attacker penalty')
      .listen();

    // Read-only status (dat.GUI displays live because we call .listen())
    const status = { attackers: 0, nextWaveIn: 0 };
    const updateStatus = () => {
      status.attackers = this.tokenHolders.size;
      status.nextWaveIn = Math.max(0, Math.round((this._nextAttackAllowedAt - Date.now())));
    };
    updateStatus();
    this._editorFolder.add(status, 'attackers').name('Active attackers').listen();
    this._editorFolder.add(status, 'nextWaveIn').name('Next wave in (ms)').listen();

    // Refresh status every frame by hooking into dat.GUI's render loop
    const orig = this._editorFolder.updateDisplay?.bind(this._editorFolder);
    if (orig) {
      this._editorFolder.updateDisplay = () => { updateStatus(); orig(); };
    }
  }

  // ─── Static registration ────────────────────────────────────────────────────

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
}
