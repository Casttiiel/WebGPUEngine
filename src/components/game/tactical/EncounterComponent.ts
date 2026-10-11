import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { DevBridge } from '../../../core/debug/DevBridge';
import { ModuleGameController } from '../../../modules/game/ModuleGameController';
import { UnitComponent } from './UnitComponent';
import { PartyComponent } from './PartyComponent';
import { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { UnitObstacles } from './UnitObstacles';
import { hasLineOfSight, planPath, truncatePath, type PathPlan } from './TacticalQueries';

export type EncounterState = 'exploration' | 'combat' | 'victory' | 'defeat';

export type EncounterComponentDataType = Readonly<{
  /** Al empezar un combate entran los enemigos a esta distancia de la party (m). Default 15. */
  joinRadius?: number;
  /** Segundos que tarda en pasar turno un enemigo (hasta que exista la IA). Default 0.8. */
  enemyTurnDelay?: number;
  /** Segundos que se muestra "VICTORIA" antes de volver a exploración. Default 2. */
  victoryTime?: number;
}>;

/** Recursos de un turno: el esqueleto de la economía de acciones de BG3. */
export interface TurnResources {
  action: number;
  bonusAction: number;
  /** Metros de movimiento que quedan. */
  movement: number;
}

interface Combatant {
  unit: UnitComponent;
  initiative: number;
  /** Desempate de iniciativa (aleatorio, semilla del juego). */
  tiebreak: number;
}

export interface MovePlan {
  plan: PathPlan;
  /** Metros disponibles (Infinity fuera de combate). */
  budget: number;
  /** La unidad puede moverse ahora mismo (es su turno / está seleccionada, no se está moviendo). */
  allowed: boolean;
  /** El camino completo cabe en el presupuesto de movimiento. */
  affordable: boolean;
  /**
   * Lo que se recorrería de verdad: el camino completo si cabe; si no, el mismo camino
   * recortado al presupuesto (se avanza hasta el punto más lejano alcanzable).
   */
  walk: PathPlan;
  /** Se puede ejecutar: permitido y hay algo que recorrer. */
  canMove: boolean;
  reason?: string;
}

const EYE_HEIGHT = 0.7; // sobre el centro de la cápsula
const DETECTION_INTERVAL = 0.25;
const EPS = 0.05;

/**
 * EncounterComponent — máquina de estados del juego táctico y combate por turnos.
 *
 *   exploration ──(un enemigo ve a la party)──▶ combat ──▶ victory ──▶ exploration
 *                                                    └──▶ defeat
 *
 * Combate: iniciativa d20 (RNG del juego, reproducible con ?seed), rondas, recursos por
 * turno (acción, acción adicional, metros), fin de turno manual (Espacio / botón) o
 * automático sin recursos, y enemigos que se unen a mitad de combate.
 *
 * Las salidas por muerte (todos los enemigos muertos / party caída) llegan con el ataque
 * (punto 12); de momento el combate se termina con endCombat() (comando de debug).
 *
 * También es quien aplica las reglas de movimiento (planMove / requestMove) para que la
 * UI, el MCP y la futura IA usen exactamente la misma lógica.
 */
export class EncounterComponent extends Component {
  private joinRadius = 15;
  private enemyTurnDelay = 0.8;
  private victoryTime = 2;

  private state: EncounterState = 'exploration';
  private combatants: Combatant[] = [];
  private turnIndex = 0;
  private round = 0;
  private resources: TurnResources = { action: 0, bonusAction: 0, movement: 0 };
  private turnTimer = 0;
  private stateTimer = 0;
  private detectionTimer = 0;
  private listeners: ((event: string) => void)[] = [];
  /**
   * Enemigos de combates ya terminados: no vuelven a detectar. Sustituye a "muertos" hasta
   * que exista el ataque (punto 12).
   */
  private disengaged = new Set<UnitComponent>();
  private initialized = false;

  private readonly tmpA = vec3.create();
  private readonly tmpB = vec3.create();

  public load(data: EncounterComponentDataType): void {
    this.joinRadius = data.joinRadius ?? this.joinRadius;
    this.enemyTurnDelay = data.enemyTurnDelay ?? this.enemyTurnDelay;
    this.victoryTime = data.victoryTime ?? this.victoryTime;
    if (!ModuleGameController.gameplayHuds.includes('COMBAT_HUD')) {
      ModuleGameController.gameplayHuds.push('COMBAT_HUD');
    }
  }

  public update(dt: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.registerDevCommands();
    }

    switch (this.state) {
      case 'exploration':
        this.detectionTimer -= dt;
        if (this.detectionTimer <= 0) {
          this.detectionTimer = DETECTION_INTERVAL;
          const spotted = this.findDetection(new Set());
          if (spotted) this.startCombat(spotted.enemy);
        }
        break;
      case 'combat':
        this.updateCombat(dt);
        break;
      case 'victory':
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this.setState('exploration');
        break;
      case 'defeat':
        break;
    }

    // Obstáculos: todas las unidades menos la que actúa.
    UnitObstacles.sync(this.getActingUnit());
  }

  // ── Consultas (UI, MCP) ──────────────────────────────────────────────────

  public getState(): EncounterState {
    return this.state;
  }

  public isInCombat(): boolean {
    return this.state === 'combat';
  }

  public getRound(): number {
    return this.round;
  }

  /** Unidad cuyo turno es (solo en combate). */
  public getActiveUnit(): Entity | null {
    if (this.state !== 'combat') return null;
    return this.combatants[this.turnIndex]?.unit.getOwner() ?? null;
  }

  public getActiveUnitName(): string | null {
    return this.getActiveUnit()?.getName() ?? null;
  }

  /** Orden de turnos (nombres), empezando por el primero de la ronda. */
  public getTurnOrder(): string[] {
    return this.combatants.map((c) => c.unit.getOwner().getName());
  }

  public getCombatants(): { name: string; faction: string; initiative: number }[] {
    return this.combatants.map((c) => ({
      name: c.unit.getOwner().getName(),
      faction: c.unit.getFaction(),
      initiative: c.initiative,
    }));
  }

  public getResources(): TurnResources {
    return { ...this.resources };
  }

  public isPlayerTurn(): boolean {
    const active = this.getActiveUnit();
    return active !== null && PartyComponent.find()?.isMember(active) === true;
  }

  /** La unidad que actúa: la del turno en combate, la seleccionada fuera de combate. */
  public getActingUnit(): Entity | null {
    if (this.state === 'combat') return this.getActiveUnit();
    if (this.state === 'exploration') return PartyComponent.find()?.getSelected() ?? null;
    return null;
  }

  public onEvent(listener: (event: string) => void): void {
    this.listeners.push(listener);
  }

  // ── Movimiento (reglas compartidas por jugador, MCP e IA) ────────────────

  public planMove(entity: Entity, destination: vec3): MovePlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const empty: PathPlan = { points: [], length: 0, reachable: false };
    if (!unit) {
      return {
        plan: empty,
        walk: empty,
        budget: 0,
        allowed: false,
        affordable: false,
        canMove: false,
        reason: 'not a unit',
      };
    }

    let allowed = !unit.isMoving();
    let reason: string | undefined = allowed ? undefined : 'unit is already moving';
    let budget = Infinity;
    if (this.state === 'combat') {
      if (entity !== this.getActiveUnit()) {
        allowed = false;
        reason = 'not this unit’s turn';
      }
      budget = this.resources.movement;
    } else if (this.state === 'exploration') {
      if (entity !== PartyComponent.find()?.getSelected()) {
        allowed = false;
        reason = 'only the selected party member moves in exploration';
      }
    } else {
      allowed = false;
      reason = `cannot move during ${this.state}`;
    }

    const plan = planPath(unit.getFeetPosition(this.tmpA), destination);
    const affordable = plan.reachable && plan.length <= budget + EPS;
    // Destino demasiado lejos: se recorre el mismo camino hasta donde llegue el movimiento.
    const walk = affordable
      ? plan
      : plan.reachable && budget > EPS
        ? truncatePath(plan.points, budget)
        : empty;
    const canMove = allowed && walk.points.length >= 2;
    if (allowed && !plan.reachable) reason = 'destination not reachable';
    else if (allowed && !canMove) reason = 'no movement left';
    return {
      plan,
      walk,
      budget,
      allowed,
      affordable,
      canMove,
      ...(reason !== undefined && { reason }),
    };
  }

  /** Mueve la unidad si las reglas lo permiten. En combate descuenta los metros recorridos. */
  public requestMove(entity: Entity, destination: vec3): MovePlan & { ok: boolean } {
    // Asegura que la planificación ve los obstáculos actuales (y no el de la propia unidad).
    UnitObstacles.sync(this.getActingUnit());
    const move = this.planMove(entity, destination);
    const ok = move.canMove;
    if (ok) {
      if (this.state === 'combat') {
        this.resources.movement = Math.max(0, this.resources.movement - move.walk.length);
      }
      const unit = entity.getComponent('unit') as UnitComponent;
      void unit.moveAlong(move.walk.points);
      this.emit('move');
    }
    return { ...move, ok };
  }

  // ── Combate ──────────────────────────────────────────────────────────────

  /** Empieza un combate (normalmente al detectar a la party; también vía MCP). Sin enemigos cerca, no. */
  public startCombat(detector: Entity | null = null): boolean {
    if (this.state === 'combat') return false;
    const party = PartyComponent.find();
    const members = party?.getMembers() ?? [];
    const memberPositions = members.map((m) =>
      (m.getComponent('unit') as UnitComponent).getFeetPosition(vec3.create()),
    );

    // Todos los enemigos cerca de algún miembro de la party (más el que detectó).
    const enemies = UnitComponent.getAll().filter((u) => {
      if (u.getFaction() !== 'enemy' || this.disengaged.has(u)) return false;
      if (u.getOwner() === detector) return true;
      const p = u.getFeetPosition(this.tmpA);
      return memberPositions.some((m) => vec3.distance(m, p) <= this.joinRadius);
    });

    if (enemies.length === 0) return false;

    this.combatants = [];
    for (const m of members)
      this.combatants.push(this.rollInitiative(m.getComponent('unit') as UnitComponent));
    for (const e of enemies) this.combatants.push(this.rollInitiative(e));
    this.combatants.sort(compareInitiative);

    for (const c of this.combatants) c.unit.stop();
    this.round = 1;
    this.turnIndex = 0;
    this.setState('combat');
    this.beginTurn();
    return true;
  }

  /** Termina el turno de la unidad activa (si no se está moviendo). */
  public endTurn(): boolean {
    if (this.state !== 'combat') return false;
    const active = this.combatants[this.turnIndex];
    if (active?.unit.isMoving()) return false;
    this.turnIndex++;
    if (this.turnIndex >= this.combatants.length) {
      this.turnIndex = 0;
      this.round++;
      this.emit('round');
    }
    this.beginTurn();
    return true;
  }

  /**
   * Termina el combate. Hasta que exista el ataque (punto 12) es un comando de debug; luego
   * lo llamarán las condiciones de victoria (enemigos muertos) y derrota (party caída).
   */
  public endCombat(result: 'victory' | 'defeat' | 'exploration' = 'victory'): void {
    if (this.state !== 'combat') return;
    for (const c of this.combatants) {
      c.unit.stop();
      if (c.unit.getFaction() === 'enemy') this.disengaged.add(c.unit);
    }
    this.combatants = [];
    this.round = 0;
    this.turnIndex = 0;
    this.setState(result);
    if (result === 'victory') this.stateTimer = this.victoryTime;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private updateCombat(dt: number): void {
    // Enemigos que ven a la party a mitad de combate se unen.
    this.detectionTimer -= dt;
    if (this.detectionTimer <= 0) {
      this.detectionTimer = DETECTION_INTERVAL;
      const inCombat = new Set(this.combatants.map((c) => c.unit));
      let spotted = this.findDetection(inCombat);
      while (spotted) {
        this.joinCombat(spotted.enemy.getComponent('unit') as UnitComponent);
        inCombat.add(spotted.enemy.getComponent('unit') as UnitComponent);
        spotted = this.findDetection(inCombat);
      }
    }

    const active = this.combatants[this.turnIndex];
    if (!active || active.unit.isMoving()) return;

    if (this.isPlayerTurn()) {
      if (Engine.getInput().isKeyJustPressed(KeyCode.SPACE)) {
        this.endTurn();
      } else if (
        this.resources.action === 0 &&
        this.resources.bonusAction === 0 &&
        this.resources.movement < EPS
      ) {
        this.endTurn(); // sin recursos
      }
    } else {
      // Hasta que haya IA (Fase 5): el enemigo pasa turno.
      this.turnTimer -= dt;
      if (this.turnTimer <= 0) this.endTurn();
    }
  }

  private beginTurn(): void {
    const active = this.combatants[this.turnIndex];
    if (!active) return;
    this.resources = { action: 1, bonusAction: 1, movement: active.unit.getMovement() };
    this.turnTimer = this.enemyTurnDelay;

    const entity = active.unit.getOwner();
    const party = PartyComponent.find();
    if (party?.isMember(entity)) {
      party.select(entity, 'code'); // la cámara lo sigue
    } else {
      this.getCamera()?.focusOn(entity, true);
    }
    this.emit('turn');
  }

  /** Un enemigo que entra a mitad de combate se coloca por su iniciativa. */
  private joinCombat(unit: UnitComponent): void {
    const combatant = this.rollInitiative(unit);
    let index = this.combatants.findIndex((c) => compareInitiative(combatant, c) < 0);
    if (index < 0) index = this.combatants.length;
    this.combatants.splice(index, 0, combatant);
    // Si entra antes (o en) la posición actual, la unidad activa no cambia: juega la ronda siguiente.
    if (index <= this.turnIndex) this.turnIndex++;
    this.emit('join');
  }

  private rollInitiative(unit: UnitComponent): Combatant {
    return { unit, initiative: 1 + Math.floor(Math.random() * 20), tiebreak: Math.random() };
  }

  /** Primer enemigo (fuera de `exclude`) que ve a algún miembro de la party. */
  private findDetection(exclude: Set<UnitComponent>): { enemy: Entity; target: Entity } | null {
    const party = PartyComponent.find()?.getMembers() ?? [];
    for (const enemy of UnitComponent.getAll()) {
      const range = enemy.getSightRange();
      if (
        enemy.getFaction() !== 'enemy' ||
        range <= 0 ||
        exclude.has(enemy) ||
        this.disengaged.has(enemy)
      )
        continue;
      const eye = enemy.getPosition(this.tmpA);
      eye[1] = eye[1]! + EYE_HEIGHT;
      for (const member of party) {
        const target = (member.getComponent('unit') as UnitComponent).getPosition(this.tmpB);
        target[1] = target[1]! + EYE_HEIGHT;
        if (vec3.distance(eye, target) <= range && hasLineOfSight(eye, target)) {
          return { enemy: enemy.getOwner(), target: member };
        }
      }
    }
    return null;
  }

  private setState(state: EncounterState): void {
    if (state === this.state) return;
    this.state = state;
    this.emit(`state:${state}`);
  }

  private emit(event: string): void {
    for (const l of this.listeners) l(event);
  }

  private getCamera(): TacticalCameraControllerComponent | null {
    const list = Engine.getEntities()
      .getObjectManagerByName('tactical_camera_controller')
      ?.getList();
    return (list?.[0] as TacticalCameraControllerComponent | undefined) ?? null;
  }

  /** get_combat_state / game_command del MCP. */
  private registerDevCommands(): void {
    DevBridge.registerCombatProvider({
      getState: () => ({
        state: this.state,
        round: this.round,
        activeUnit: this.getActiveUnitName(),
        playerTurn: this.isPlayerTurn(),
        resources: this.getResources(),
        turnOrder: this.getCombatants(),
        selected: PartyComponent.find()?.getSelectedName() ?? null,
      }),
      command: (name, args) => {
        const unitArg = (key = 'unit'): Entity => {
          const ref = args[key];
          const entity =
            typeof ref === 'string'
              ? Engine.getEntities().getEntityByName(ref)
              : this.getActingUnit();
          if (!entity) throw new Error(`Unit not found: ${String(ref)}`);
          return entity;
        };
        switch (name) {
          case 'move': {
            const to = args.to as [number, number, number] | undefined;
            if (!Array.isArray(to)) throw new Error('move needs args.to = [x, y, z]');
            const result = this.requestMove(unitArg(), vec3.fromValues(to[0], to[1], to[2]));
            return {
              ok: result.ok,
              reason: result.reason ?? null,
              length: result.plan.length,
              walked: result.walk.length,
              budget: result.budget,
            };
          }
          case 'plan_move': {
            const to = args.to as [number, number, number];
            const r = this.planMove(unitArg(), vec3.fromValues(to[0], to[1], to[2]));
            return {
              reachable: r.plan.reachable,
              length: r.plan.length,
              allowed: r.allowed,
              affordable: r.affordable,
              canMove: r.canMove,
              walkLength: r.walk.length,
              reason: r.reason ?? null,
              points: r.plan.points.map((p) => Array.from(p)),
            };
          }
          case 'end_turn':
            return { ok: this.endTurn(), activeUnit: this.getActiveUnitName(), round: this.round };
          case 'start_combat':
            return {
              started: this.startCombat(null),
              state: this.state,
              turnOrder: this.getTurnOrder(),
            };
          case 'end_combat':
            this.endCombat(
              (args.result as 'victory' | 'defeat' | 'exploration' | undefined) ?? 'victory',
            );
            return { state: this.state };
          case 'select':
            PartyComponent.find()?.select(unitArg(), 'code');
            return { selected: PartyComponent.find()?.getSelectedName() ?? null };
          default:
            throw new Error(
              `Unknown command '${name}'. Available: move, plan_move, end_turn, start_combat, end_combat, select`,
            );
        }
      },
    });
  }

  public override dispose(): void {
    DevBridge.registerCombatProvider(null);
    this.listeners = [];
  }

  /** El encuentro de la escena (si hay). */
  public static find(): EncounterComponent | null {
    const list = Engine.getEntities().getObjectManagerByName('encounter')?.getList();
    return (list?.[0] as EncounterComponent | undefined) ?? null;
  }
}

/** Mayor iniciativa primero; desempate aleatorio. */
function compareInitiative(a: Combatant, b: Combatant): number {
  return b.initiative - a.initiative || b.tiebreak - a.tiebreak;
}
