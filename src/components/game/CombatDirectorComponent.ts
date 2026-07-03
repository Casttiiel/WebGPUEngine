import { Component } from '../../core/ecs/Component';
import { CombatDirectorComponentData } from '../../types/CombatDirectorComponentData.type';
import { CombatEventBus } from '../../ai/CombatEventBus';
import { CombatSlotManager } from '../../ai/CombatSlotManager';
import { EnemyRole } from '../../types/EnemyRole.enum';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { vec3 } from 'gl-matrix';

export class CombatDirectorComponent extends Component {
  static instance: CombatDirectorComponent | null = null;

  // ── Tunables ──────────────────────────────────────────────────────────────
  public aggressiveness: number = 0.5;
  public attackPaceMs: number = 1500;
  public lastAttackerPenalty: number = 60;

  // Threat Budget (Tier 2.9) — limits dangerous attacker combinations.
  public threatBudget: number = 100;

  // Dynamic Pressure Budget (Tier 4.17) — threat cost amortizes over this duration
  // instead of being restored instantly, producing natural high-pressure bursts.
  public pressureDecayMs: number = 2500;

  // ── Config ────────────────────────────────────────────────────────────────
  private _baseMaxAttackers: number = 1;
  private _baseAggressiveness: number = 0.5;

  // ── Attack token pool ─────────────────────────────────────────────────────
  private readonly tokenHolders = new Set<EnemyControllerComponent>();

  // ── Pace timer ────────────────────────────────────────────────────────────
  private _nextAttackAllowedAt: number = 0;

  // ── Threat tracking (Tier 2.9 + 4.17) ───────────────────────────────────
  private _currentThreat: number = 0;
  private readonly _tokenThreatCosts = new Map<EnemyControllerComponent, number>();
  private readonly _decayQueue: Array<{ amount: number; expiresAt: number }> = [];

  // ── Last-attacker penalty ─────────────────────────────────────────────────
  private _lastReleaser: EnemyControllerComponent | null = null;

  // ── Roles ─────────────────────────────────────────────────────────────────
  private readonly _roles = new Map<EnemyControllerComponent, EnemyRole>();

  // ── Pressure escalation ────────────────────────────────────────────────────
  private _timeSincePlayerDamaged: number = 0;
  private _unsub: Array<() => void> = [];

  // ── Slot system (Tier 4.15) ──────────────────────────────────────────────
  public readonly slotManager: CombatSlotManager = new CombatSlotManager(8, 7.0);

  // ── Difficulty preset ─────────────────────────────────────────────────────
  public _difficulty: string = 'normal';

  // ── Editor ────────────────────────────────────────────────────────────────
  // Live status updated each game frame so dat.GUI .listen() always reads current values.
  private _statusDisplay: { attackers: number; waveCooldown: number; threat: number } | null = null;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: CombatDirectorComponentData): void {
    this._baseMaxAttackers = data.baseMaxAttackers ?? 1;
    this._baseAggressiveness = data.aggressiveness ?? 0.5;
    this.aggressiveness = this._baseAggressiveness;
    this.attackPaceMs = data.attackPaceMs ?? 1500;

    CombatDirectorComponent.instance = this;
    CombatSlotManager.instance = this.slotManager;

    this._unsub.push(
      CombatEventBus.on('player_damaged', () => {
        this._timeSincePlayerDamaged = 0;
        this.aggressiveness = this._baseAggressiveness;
      }),
    );
  }

  // ─── Derived values ────────────────────────────────────────────────────────

  /**
   * Maximum simultaneous attackers.
   * Defined directly by the preset (_baseMaxAttackers) — not scaled by aggressiveness,
   * which would create unintended extra attackers at mid-range values.
   */
  public getMaxActiveAttackers(): number {
    return this._baseMaxAttackers;
  }

  // ─── Token API ─────────────────────────────────────────────────────────────

  public acquireToken(enemy: EnemyControllerComponent): boolean {
    if (this.tokenHolders.has(enemy)) return true;

    const maxActive = this.getMaxActiveAttackers();
    if (this.tokenHolders.size >= maxActive) return false;

    if (this.tokenHolders.size === 0 && Date.now() < this._nextAttackAllowedAt) return false;

    const cost = enemy.getAttackThreatCost();
    if (this._currentThreat + cost > this.threatBudget) return false;

    this._currentThreat += cost;
    this._tokenThreatCosts.set(enemy, cost);
    this.slotManager.releaseSlot(enemy); // free orbit slot when enemy starts attacking
    this.tokenHolders.add(enemy);
    this._assignRole(enemy);
    return true;
  }

  public releaseToken(enemy: EnemyControllerComponent): void {
    if (!this.tokenHolders.has(enemy)) return;
    this.tokenHolders.delete(enemy);
    this._roles.delete(enemy);
    this._lastReleaser = enemy;

    // Tier 4.17 — amortize threat cost over pressureDecayMs
    const cost = this._tokenThreatCosts.get(enemy) ?? 0;
    this._tokenThreatCosts.delete(enemy);
    if (cost > 0) {
      this._decayQueue.push({ amount: cost, expiresAt: Date.now() + this.pressureDecayMs });
    }

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

  public getRole(enemy: EnemyControllerComponent): EnemyRole {
    return this._roles.get(enemy) ?? EnemyRole.AGGRESSOR;
  }

  public assignRole(enemy: EnemyControllerComponent, role: EnemyRole): void {
    this._roles.set(enemy, role);
  }

  private _assignRole(enemy: EnemyControllerComponent): void {
    if (this._roles.has(enemy)) return;
    const role = this.tokenHolders.size === 1 ? EnemyRole.AGGRESSOR : EnemyRole.FLANKER;
    this._roles.set(enemy, role);
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  public update(dt: number): void {
    this._timeSincePlayerDamaged += dt;
    const pressureGain = this._timeSincePlayerDamaged / 30;
    this.aggressiveness = Math.min(1, this._baseAggressiveness + pressureGain);

    const now = Date.now();

    // Tier 4.17 — drain expired threat decay entries
    while (this._decayQueue.length > 0 && this._decayQueue[0]!.expiresAt <= now) {
      const entry = this._decayQueue.shift()!;
      this._currentThreat = Math.max(0, this._currentThreat - entry.amount);
    }

    // Tier 4.15 — update slot positions around player
    const playerPos = this._getPlayerPosition();
    if (playerPos) this.slotManager.update(playerPos);

    // ── Priority-based token grant ────────────────────────────────────────────
    const maxActive = this.getMaxActiveAttackers();
    if (this.tokenHolders.size < maxActive && now >= this._nextAttackAllowedAt) {
      const candidates = ([...EnemyControllerComponent.getAll()] as EnemyControllerComponent[])
        .filter(e =>
          !this.tokenHolders.has(e) &&
          !e.isOnIndividualCooldown() &&
          e.bb.get<boolean>('canSeePlayer', false),
        )
        .sort((a, b) => this._score(b) - this._score(a));

      for (const e of candidates) {
        if (this.tokenHolders.size >= maxActive) break;
        const cost = e.getAttackThreatCost();
        if (this._currentThreat + cost > this.threatBudget) continue;
        this._currentThreat += cost;
        this._tokenThreatCosts.set(e, cost);
        this.slotManager.releaseSlot(e);
        this.tokenHolders.add(e);
        this._assignRole(e);
      }
    }

    // Update editor status display (read by dat.GUI .listen() each animation frame)
    if (this._statusDisplay) {
      this._statusDisplay.attackers = this.tokenHolders.size;
      this._statusDisplay.waveCooldown = Math.max(0, Math.round(this._nextAttackAllowedAt - now));
      this._statusDisplay.threat = Math.round(this._currentThreat);
    }
  }

  private _score(e: EnemyControllerComponent): number {
    const pos = e.bb.get<vec3>('position');
    const playerPos = e.bb.get<vec3>('playerPosition');
    const distScore = pos && playerPos ? Math.max(0, 30 - vec3.distance(pos, playerPos)) * 5 : 0;
    const waitScore = e.getTimeSinceLastAttack() * 10;
    const recencyPenalty = e === this._lastReleaser ? -this.lastAttackerPenalty : 0;
    return distScore + waitScore + recencyPenalty;
  }

  private _getPlayerPosition(): vec3 | null {
    for (const e of EnemyControllerComponent.getAll()) {
      if (e.bb.get<boolean>('canSeePlayer', false)) return e.bb.get<vec3>('playerPosition') ?? null;
    }
    for (const e of EnemyControllerComponent.getAll()) {
      const p = e.bb.get<vec3>('playerPosition');
      if (p) return p;
    }
    return null;
  }

  // ─── Difficulty presets ────────────────────────────────────────────────────

  public setDifficulty(level: 'easy' | 'normal' | 'hard' | 'veryHard'): void {
    switch (level) {
      case 'easy':     this._baseMaxAttackers = 1; this.attackPaceMs = 8000; this._baseAggressiveness = 0.2;  break;
      case 'normal':   this._baseMaxAttackers = 1; this.attackPaceMs = 5000; this._baseAggressiveness = 0.5;  break;
      case 'hard':     this._baseMaxAttackers = 2; this.attackPaceMs = 300;  this._baseAggressiveness = 0.75; break;
      case 'veryHard': this._baseMaxAttackers = 3; this.attackPaceMs = 1500; this._baseAggressiveness = 1.0;  break;
    }
    this.aggressiveness = this._baseAggressiveness;
  }

  // ─── Editor GUI ────────────────────────────────────────────────────────────

  public override renderInMenu(folder?: any): void {
    if (this._editorFolder || !folder) return;
    this._editorFolder = folder.addFolder('Combat Director');
    this._editorFolder.open();

    // Difficulty preset — sets all tunables at once
    this._editorFolder
      .add(this, '_difficulty', { Fácil: 'easy', Normal: 'normal', Difícil: 'hard', 'Muy difícil': 'veryHard' })
      .name('Dificultad')
      .onChange((v: 'easy' | 'normal' | 'hard' | 'veryHard') => this.setDifficulty(v));

    // Max simultaneous attackers — set by difficulty preset
    this._editorFolder.add(this, '_baseMaxAttackers', 1, 4, 1).name('Max atacantes').listen();

    // Time enemies wait between attack waves (lower = more aggressive)
    this._editorFolder.add(this, 'attackPaceMs', 100, 8000, 50).name('Pausa entre olas (ms)').listen();

    // Penalty to re-select the most recent attacker — promotes variety
    this._editorFolder.add(this, 'lastAttackerPenalty', 0, 200, 5).name('Penalización repetición').listen();

    // Threat budget — prevents dangerous enemy type combinations
    this._editorFolder.add(this, 'threatBudget', 20, 200, 5).name('Threat budget').listen();

    // How long (ms) before a finished attacker's threat cost is returned to the pool
    this._editorFolder.add(this, 'pressureDecayMs', 500, 6000, 100).name('Decay presión (ms)').listen();

    // ── Live status (updated each game frame via update(), read by .listen()) ──
    this._statusDisplay = { attackers: 0, waveCooldown: 0, threat: 0 };
    this._editorFolder.add(this._statusDisplay, 'attackers').name('Atacantes activos').listen();
    // waveCooldown: ms remaining before the next attack wave is allowed.
    // Shows 0 when enemies can attack freely, counts down after each wave.
    this._editorFolder.add(this._statusDisplay, 'waveCooldown').name('Cooldown ola (ms)').listen();
    this._editorFolder.add(this._statusDisplay, 'threat').name('Amenaza activa').listen();
  }

  // ─── Static registration ───────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DAMAGED, 'player_controller', (_comp) => {
      CombatEventBus.emit('player_damaged');
    });
  }

  // ─── Boilerplate ───────────────────────────────────────────────────────────

  public override dispose(): void {
    if (CombatDirectorComponent.instance === this) CombatDirectorComponent.instance = null;
    if (CombatSlotManager.instance === this.slotManager) CombatSlotManager.instance = null;
    this.tokenHolders.clear();
    this._roles.clear();
    this._tokenThreatCosts.clear();
    this._decayQueue.length = 0;
    this.slotManager.clear();
    for (const u of this._unsub) u();
    this._unsub.length = 0;
  }

  public renderDebug(): void {}
}
