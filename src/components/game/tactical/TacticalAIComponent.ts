import { Component } from '../../../core/ecs/Component';
import { BehaviorTree } from '../../../ai/BehaviorTree';
import { Blackboard } from '../../../ai/Blackboard';
import { Status } from '../../../ai/BehaviorNode';
import { Sequence } from '../../../ai/nodes/Sequence';
import { Action } from '../../../ai/nodes/Action';
import { AlwaysSucceed } from '../../../ai/nodes/Decorators';
import { Wait } from '../../../ai/nodes/Wait';
import type { EncounterComponent } from './EncounterComponent';
import type { UnitComponent } from './UnitComponent';
import { planTurn, type AIProfile, type AIRole, type TurnPlan } from './TacticalPlanner';

export type TacticalAIComponentDataType = Readonly<{
  /** melee: acercarse y pegar. ranged: buscar alcance y línea de visión, guardando distancia. Default: ranged si tiene algún ataque a distancia. */
  role?: AIRole;
  /** Por debajo de esta fracción de vida prefiere retirarse (0 = nunca). Default 0.3. */
  retreatHp?: number;
  /** A distancia: separación que intenta mantener con el enemigo más cercano (m). Default 6. */
  preferredDistance?: number;
  /** Pausa al empezar el turno, antes de actuar (s). Default 0.6. */
  thinkTime?: number;
  /** Pausa entre moverse y atacar (s). Default 0.25. */
  pauseTime?: number;
  /** Pausa tras actuar, antes de pasar el turno (s). Default 0.5. */
  endTime?: number;
}>;

/**
 * TacticalAIComponent — IA de combate por turnos de una unidad.
 *
 * Cuando empieza su turno, EncounterComponent llama a beginTurn() y después a updateTurn()
 * cada frame hasta que devuelve true (turno terminado). Por dentro es un Behavior Tree
 * (src/ai) que se ejecuta a lo largo de varios frames:
 *
 *   pensar (pausa) → planificar (TacticalPlanner) → moverse → esperar a llegar → pausa
 *     → atacar → esperar al golpe → pausa → fin de turno
 *
 * Actúa con las mismas reglas y la misma API que el jugador y el MCP (requestMove /
 * requestAttack de EncounterComponent). Las pausas son para que el jugador entienda qué
 * hace la IA; la cámara sigue a la unidad activa.
 */
export class TacticalAIComponent extends Component {
  private role: AIRole | null = null;
  private retreatHp = 0.3;
  private preferredDistance = 6;
  private thinkTime = 0.6;
  private pauseTime = 0.25;
  private endTime = 0.5;

  private tree: BehaviorTree | null = null;
  private readonly bb = new Blackboard();
  private encounter: EncounterComponent | null = null;
  private lastPlan: TurnPlan | null = null;

  public load(data: TacticalAIComponentDataType): void {
    this.role = data.role ?? null;
    this.retreatHp = data.retreatHp ?? this.retreatHp;
    this.preferredDistance = data.preferredDistance ?? this.preferredDistance;
    this.thinkTime = data.thinkTime ?? this.thinkTime;
    this.pauseTime = data.pauseTime ?? this.pauseTime;
    this.endTime = data.endTime ?? this.endTime;
  }

  public update(_dt: number): void {}

  // ── API (EncounterComponent) ─────────────────────────────────────────────

  /** Empieza su turno: el árbol vuelve al principio. */
  public beginTurn(encounter: EncounterComponent): void {
    this.encounter = encounter;
    this.tree ??= new BehaviorTree(this.buildTree(), this.bb);
    this.tree.reset();
    this.bb.clear();
    this.lastPlan = null;
  }

  /** Avanza el turno un frame. true = ha terminado (el encuentro pasa el turno). */
  public updateTurn(dt: number): boolean {
    if (!this.tree) return true;
    this.bb.set('dt', dt);
    return this.tree.step() !== Status.RUNNING;
  }

  /** Plan del turno actual o del último (debug / MCP). */
  public getLastPlan(): TurnPlan | null {
    return this.lastPlan;
  }

  public getProfile(): AIProfile {
    const unit = this.getUnit();
    return {
      role: this.role ?? (unit?.getAttacks().some((a) => a.kind === 'ranged') ? 'ranged' : 'melee'),
      retreatHp: this.retreatHp,
      preferredDistance: this.preferredDistance,
    };
  }

  // ── Árbol ────────────────────────────────────────────────────────────────

  private buildTree(): Sequence {
    const plan = () => this.bb.get<TurnPlan>('plan');
    return new Sequence(
      [
        new Wait('think', () => this.thinkTime),
        new Action('plan', () => {
          const unit = this.getUnit();
          if (!unit || !this.encounter) return Status.FAILURE;
          this.lastPlan = planTurn(this.encounter, unit, this.getProfile());
          this.bb.set('plan', this.lastPlan);
          return Status.SUCCESS;
        }),
        new AlwaysSucceed(
          new Sequence(
            [
              new Action('move', () => {
                const p = plan();
                if (!p?.move || !this.encounter) return Status.FAILURE;
                const ok = this.encounter.requestMove(this.getOwner(), p.move).ok;
                return ok ? Status.SUCCESS : Status.FAILURE;
              }),
              this.waitIdle('arrive'),
              new Wait('pause', () => this.pauseTime),
            ],
            { label: 'Move' },
          ),
        ),
        new AlwaysSucceed(
          new Sequence(
            [
              new Action('attack', () => {
                const p = plan();
                if (!p?.attack || !this.encounter) return Status.FAILURE;
                const r = this.encounter.requestAttack(
                  this.getOwner(),
                  p.attack.target,
                  p.attack.attackId,
                );
                return r.ok ? Status.SUCCESS : Status.FAILURE;
              }),
              this.waitIdle('resolve'),
            ],
            { label: 'Attack' },
          ),
        ),
        new Wait('end', () => this.endTime),
      ],
      { label: 'Turn' },
    );
  }

  /** RUNNING mientras la unidad se mueve, ataca o hay un golpe por resolver. */
  private waitIdle(label: string): Action {
    return new Action(label, () =>
      this.getUnit()?.isBusy() || this.encounter?.isResolving() ? Status.RUNNING : Status.SUCCESS,
    );
  }

  private getUnit(): UnitComponent | null {
    return this.getOwner().getComponent('unit') as UnitComponent | null;
  }
}
