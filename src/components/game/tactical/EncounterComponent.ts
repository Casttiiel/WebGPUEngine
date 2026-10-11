import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { DevBridge } from '../../../core/debug/DevBridge';
import { ModuleGameController } from '../../../modules/game/ModuleGameController';
import { UnitComponent, type UnitAttack } from './UnitComponent';
import { PartyComponent } from './PartyComponent';
import { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { UnitObstacles } from './UnitObstacles';
import { hasLineOfSight, planPath, truncatePath, type PathPlan } from './TacticalQueries';
import {
  EYE_HEIGHT,
  previewAttack,
  rollAttack,
  unitDistance,
  unitLineOfSight,
} from './CombatRules';

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

/** Datos de los eventos del encuentro (UI: texto flotante, rótulos). */
export interface EncounterEventData {
  /** Unidad afectada (la que recibe el golpe, cae, empieza turno…). */
  unit?: Entity;
  /** Quién lo causa (el atacante). */
  source?: Entity | null;
  amount?: number;
  hit?: boolean;
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

export interface AttackPlan {
  attack: UnitAttack | null;
  /** La unidad puede actuar ahora (su turno, le queda el recurso, no está ocupada). */
  allowed: boolean;
  /** Distancia de borde a borde (m). */
  distance: number;
  inRange: boolean;
  /** Solo cuenta para ataques a distancia (cuerpo a cuerpo: siempre true). */
  lineOfSight: boolean;
  /** Cuerpo a cuerpo fuera de alcance: movimiento hasta el objetivo antes de atacar. */
  approach: MovePlan | null;
  /** Se puede ejecutar (directamente o acercándose primero). */
  canAttack: boolean;
  hitChance: number;
  damage: number;
  reason?: string;
}

interface PendingHit {
  timer: number;
  attacker: UnitComponent;
  target: UnitComponent;
  hit: boolean;
  damage: number;
}

const DETECTION_INTERVAL = 0.25;
const EPS = 0.05;
/** Duración de un ataque (la unidad está ocupada) y momento del impacto. */
const ATTACK_TIME = 0.9;
const HIT_DELAY = 0.4;
const HIT_CLIP = 'Hit_Chest';
/** Al acercarse para atacar cuerpo a cuerpo se queda a esta fracción del alcance. */
const APPROACH_FRACTION = 0.6;
const APPROACH_CANDIDATES = 16;

/**
 * EncounterComponent — máquina de estados del juego táctico y combate por turnos.
 *
 *   exploration ──(un enemigo ve a la party / la party ataca)──▶ combat ──▶ victory ──▶ exploration
 *        ▲                                                            └──▶ defeat ──(R)──┘
 *
 * Combate: iniciativa d20 (RNG del juego, reproducible con ?seed), rondas, recursos por
 * turno (acción, acción adicional, metros), fin de turno manual (Espacio / botón) o
 * automático sin recursos útiles, y enemigos que se unen a mitad de combate.
 *
 * Ataques: cuerpo a cuerpo (si no llega, se acerca y ataca) y a distancia (alcance y línea
 * de visión). A 0 PV un enemigo muere (sale de la iniciativa) y un aliado queda caído
 * (pierde sus turnos; se levanta con 1 PV al ganar). Sin enemigos vivos → victoria; toda
 * la party caída → derrota. R reinicia el encuentro (derrota o mapa despejado).
 *
 * Es quien aplica las reglas (planMove / requestMove / planAttack / requestAttack) para que
 * la UI, el MCP y la futura IA usen exactamente la misma lógica.
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
  private listeners: ((event: string, data: EncounterEventData) => void)[] = [];
  /** Ataque cuerpo a cuerpo que espera a que la unidad termine de acercarse. */
  private pendingAttack: {
    attacker: UnitComponent;
    target: UnitComponent;
    attackId: string;
  } | null = null;
  private pendingHits: PendingHit[] = [];
  /** Enemigos de combates terminados por comando (end_combat): no vuelven a detectar. */
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

    this.updateAttacks(dt);

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

    if (this.canRestart() && Engine.getInput().isKeyJustPressed(KeyCode.R)) this.restart();

    // Obstáculos: todas las unidades vivas menos la que actúa.
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

  /** Participantes en orden de iniciativa (UI: barra de iniciativa). */
  public getCombatantUnits(): UnitComponent[] {
    return this.combatants.map((c) => c.unit);
  }

  public getCombatants(): { name: string; faction: string; initiative: number; alive: boolean }[] {
    return this.combatants.map((c) => ({
      name: c.unit.getOwner().getName(),
      faction: c.unit.getFaction(),
      initiative: c.initiative,
      alive: c.unit.isAlive(),
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

  /** ¿Se puede reiniciar el encuentro con R? En derrota, o con todos los enemigos muertos. */
  public canRestart(): boolean {
    if (this.state === 'defeat') return true;
    return (
      this.state === 'exploration' &&
      !UnitComponent.getAll().some((u) => u.getFaction() === 'enemy' && u.isAlive())
    );
  }

  /** Eventos: state:<estado>, turn, round, join, move, attack, damage, death, downed, revive, restart. */
  public onEvent(listener: (event: string, data: EncounterEventData) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
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

    let allowed = !unit.isBusy() && unit.isAlive();
    let reason: string | undefined = !unit.isAlive()
      ? 'unit is down'
      : allowed
        ? undefined
        : 'unit is busy';
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
      this.pendingAttack = null;
      const unit = entity.getComponent('unit') as UnitComponent;
      void unit.moveAlong(move.walk.points);
      this.emit('move', { unit: entity });
    }
    return { ...move, ok };
  }

  // ── Ataque (reglas compartidas por jugador, MCP e IA) ────────────────────

  /**
   * ¿Puede `entity` atacar a `targetEntity` con el ataque `attackId` (default: el primero)?
   * Cuerpo a cuerpo fuera de alcance: busca dónde acercarse con el movimiento que queda.
   */
  public planAttack(entity: Entity, targetEntity: Entity, attackId?: string | null): AttackPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const target = targetEntity.getComponent('unit') as UnitComponent | null;
    const attack = unit?.getAttack(attackId) ?? null;
    const result: AttackPlan = {
      attack,
      allowed: false,
      distance: Infinity,
      inRange: false,
      lineOfSight: false,
      approach: null,
      canAttack: false,
      hitChance: 0,
      damage: 0,
    };
    const fail = (reason: string): AttackPlan => ({ ...result, reason });
    if (!unit || !target) return fail('not a unit');
    if (!attack) return fail(`unknown attack '${attackId}'`);
    if (target === unit || target.getFaction() === unit.getFaction()) {
      return fail('cannot attack an ally');
    }
    if (!target.isAlive()) return fail('target is down');

    result.distance = unitDistance(unit, target);
    result.inRange = result.distance <= attack.range + EPS;
    result.lineOfSight = attack.kind === 'melee' || unitLineOfSight(unit, target);
    const roll = previewAttack(unit, target, attack);
    result.hitChance = roll.hitChance;
    result.damage = roll.damage;

    const permission = this.canAct(unit, attack.cost ?? 'action');
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);

    if (result.inRange && result.lineOfSight) {
      result.canAttack = true;
      return result;
    }
    if (attack.kind === 'ranged') {
      return fail(result.inRange ? 'no line of sight' : 'target out of range');
    }
    result.approach = this.planApproach(entity, unit, target, attack);
    if (!result.approach) return fail('target out of reach');
    result.canAttack = true;
    return result;
  }

  /**
   * Ataca si las reglas lo permiten. Cuerpo a cuerpo fuera de alcance: se acerca (gasta
   * metros) y ataca al llegar. Fuera de combate, atacar a un enemigo empieza el combate.
   */
  public requestAttack(
    entity: Entity,
    targetEntity: Entity,
    attackId?: string | null,
  ): AttackPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planAttack(entity, targetEntity, attackId);
    if (!plan.canAttack || !plan.attack) return { ...plan, ok: false };
    const unit = entity.getComponent('unit') as UnitComponent;
    const target = targetEntity.getComponent('unit') as UnitComponent;

    if (plan.approach) {
      const points = plan.approach.walk.points;
      const move = this.requestMove(entity, points[points.length - 1]!);
      if (!move.ok) return { ...plan, ok: false, reason: move.reason ?? 'cannot approach' };
      this.pendingAttack = { attacker: unit, target, attackId: plan.attack.id };
      return { ...plan, ok: true };
    }

    this.executeAttack(unit, target, plan.attack);
    return { ...plan, ok: true };
  }

  // ── Combate ──────────────────────────────────────────────────────────────

  /** Empieza un combate (normalmente al detectar a la party; también vía MCP). Sin enemigos cerca, no. */
  public startCombat(detector: Entity | null = null): boolean {
    if (this.state !== 'exploration') return false;
    const party = PartyComponent.find();
    const members = party?.getMembers() ?? [];
    const memberPositions = members.map((m) =>
      (m.getComponent('unit') as UnitComponent).getFeetPosition(vec3.create()),
    );

    // Todos los enemigos vivos cerca de algún miembro de la party (más el que detectó).
    const enemies = UnitComponent.getAll().filter((u) => {
      if (u.getFaction() !== 'enemy' || !u.isAlive() || this.disengaged.has(u)) return false;
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
    this.pendingAttack = null;
    this.round = 1;
    this.turnIndex = 0;
    this.setState('combat');
    this.beginTurn();
    return true;
  }

  /** Termina el turno de la unidad activa (si no está moviéndose ni atacando). */
  public endTurn(): boolean {
    if (this.state !== 'combat') return false;
    const active = this.combatants[this.turnIndex];
    if (active?.unit.isBusy() || this.pendingAttack || this.pendingHits.length) return false;
    this.nextIndex();
    this.beginTurn();
    return true;
  }

  /**
   * Termina el combate. Lo llaman las condiciones de victoria (enemigos muertos) y derrota
   * (party caída); también el comando de debug end_combat.
   */
  public endCombat(result: 'victory' | 'defeat' | 'exploration' = 'victory'): void {
    if (this.state !== 'combat') return;
    for (const c of this.combatants) {
      c.unit.stop();
      if (c.unit.getFaction() === 'enemy' && c.unit.isAlive()) this.disengaged.add(c.unit);
    }
    this.combatants = [];
    this.pendingAttack = null;
    this.round = 0;
    this.turnIndex = 0;
    if (result === 'victory') {
      // Como en BG3: los caídos se levantan al terminar el combate.
      for (const m of PartyComponent.find()?.getMembers() ?? []) {
        const unit = m.getComponent('unit') as UnitComponent;
        if (!unit.isAlive()) {
          unit.setDown(false, 1);
          this.emit('revive', { unit: m });
        }
      }
      this.stateTimer = this.victoryTime;
    }
    this.setState(result);
  }

  /** Vuelve a empezar: todas las unidades a su sitio con toda la vida, en exploración. */
  public restart(): void {
    for (const c of this.combatants) c.unit.stop();
    this.combatants = [];
    this.pendingAttack = null;
    this.pendingHits = [];
    this.disengaged.clear();
    this.round = 0;
    this.turnIndex = 0;
    for (const unit of UnitComponent.getAll()) unit.resetToSpawn();
    this.detectionTimer = DETECTION_INTERVAL;
    this.setState('exploration');
    PartyComponent.find()?.select(0, 'code');
    this.emit('restart', {});
  }

  /**
   * Daño directo a una unidad, sin atacante (debug / escenarios; más adelante trampas,
   * superficies…). Pasa por la misma ruta que un golpe: texto flotante, caída, fin de combate.
   */
  public applyDamage(entity: Entity, amount: number, source: Entity | null = null): boolean {
    const target = entity.getComponent('unit') as UnitComponent | null;
    if (!target?.isAlive() || !target.getHealth()) return false;
    this.applyHit(source?.getComponent('unit') as UnitComponent | null, target, true, amount);
    return true;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** null si la unidad puede actuar ahora gastando `cost`; si no, el motivo. */
  private canAct(unit: UnitComponent, cost: 'action' | 'bonusAction'): string | null {
    if (!unit.isAlive()) return 'unit is down';
    if (unit.isBusy() || this.pendingAttack) return 'unit is busy';
    const entity = unit.getOwner();
    if (this.state === 'combat') {
      if (entity !== this.getActiveUnit()) return 'not this unit’s turn';
      if (this.resources[cost] <= 0)
        return cost === 'action' ? 'no action left' : 'no bonus action left';
      return null;
    }
    if (this.state === 'exploration') {
      return entity === PartyComponent.find()?.getSelected()
        ? null
        : 'only the selected party member acts in exploration';
    }
    return `cannot act during ${this.state}`;
  }

  /** Mejor punto (camino más corto, dentro del presupuesto) desde el que atacar cuerpo a cuerpo. */
  private planApproach(
    entity: Entity,
    unit: UnitComponent,
    target: UnitComponent,
    attack: UnitAttack,
  ): MovePlan | null {
    const reach =
      unit.getCapsuleRadius() + target.getCapsuleRadius() + attack.range * APPROACH_FRACTION;
    const center = target.getFeetPosition(this.tmpA);
    const from = unit.getFeetPosition(this.tmpB);
    const candidates: { point: vec3; straight: number }[] = [];
    for (let i = 0; i < APPROACH_CANDIDATES; i++) {
      const angle = (i / APPROACH_CANDIDATES) * Math.PI * 2;
      const point = vec3.fromValues(
        center[0]! + Math.cos(angle) * reach,
        center[1]!,
        center[2]! + Math.sin(angle) * reach,
      );
      candidates.push({ point, straight: vec3.distance(point, from) });
    }
    candidates.sort((a, b) => a.straight - b.straight);

    let best: MovePlan | null = null;
    for (const c of candidates) {
      // Ningún camino es más corto que la línea recta.
      if (best && c.straight >= best.plan.length) break;
      const move = this.planMove(entity, c.point);
      if (!move.canMove || !move.affordable) continue;
      if (!best || move.plan.length < best.plan.length) best = move;
    }
    return best;
  }

  private executeAttack(unit: UnitComponent, target: UnitComponent, attack: UnitAttack): void {
    if (this.state === 'combat') {
      const cost = attack.cost ?? 'action';
      this.resources[cost] = Math.max(0, this.resources[cost] - 1);
    }
    unit.faceTowards(target.getPosition(this.tmpA));
    unit.playAction(attack.clip, ATTACK_TIME);
    const roll = rollAttack(unit, target, attack);
    this.pendingHits.push({ timer: HIT_DELAY, attacker: unit, target, ...roll });
    this.emit('attack', { unit: target.getOwner(), source: unit.getOwner() });
  }

  /** Ataques en curso: el que espera a terminar de acercarse y los impactos pendientes. */
  private updateAttacks(dt: number): void {
    const pending = this.pendingAttack;
    if (pending && !pending.attacker.isMoving()) {
      this.pendingAttack = null;
      const plan = this.planAttack(
        pending.attacker.getOwner(),
        pending.target.getOwner(),
        pending.attackId,
      );
      // Se ha interrumpido (p.ej. empezó el combate y no es su turno): se cancela.
      if (plan.canAttack && !plan.approach && plan.attack) {
        this.executeAttack(pending.attacker, pending.target, plan.attack);
      }
    }

    if (this.pendingHits.length === 0) return;
    const due: PendingHit[] = [];
    this.pendingHits = this.pendingHits.filter((h) => {
      h.timer -= dt;
      if (h.timer > 0) return true;
      due.push(h);
      return false;
    });
    for (const h of due) this.applyHit(h.attacker, h.target, h.hit, h.damage);
  }

  private applyHit(
    attacker: UnitComponent | null,
    target: UnitComponent,
    hit: boolean,
    damage: number,
  ): void {
    if (!target.isAlive()) return;
    const health = target.getHealth();
    const before = health?.getHp() ?? 0;
    if (hit && health) health.takeDamage(damage, attacker?.getOwner() ?? null);
    const dealt = before - (health?.getHp() ?? 0);
    this.emit('damage', {
      unit: target.getOwner(),
      source: attacker?.getOwner() ?? null,
      amount: dealt,
      hit,
    });

    if (health && health.getHp() <= 0) this.onUnitDown(target);
    else if (hit) target.playAction(HIT_CLIP);

    // La party ataca primero: empieza el combate (si quedan enemigos cerca).
    if (
      this.state === 'exploration' &&
      attacker?.getFaction() === 'party' &&
      target.getFaction() === 'enemy'
    ) {
      this.startCombat(target.isAlive() ? target.getOwner() : null);
    }
  }

  /** Vida a 0: el enemigo muere y sale de la iniciativa; el aliado queda caído. */
  private onUnitDown(unit: UnitComponent): void {
    unit.setDown(true);
    const isParty = PartyComponent.find()?.isMember(unit.getOwner()) === true;
    this.emit(isParty ? 'downed' : 'death', { unit: unit.getOwner() });
    if (this.state !== 'combat') return;

    const index = this.combatants.findIndex((c) => c.unit === unit);
    const wasActive = index === this.turnIndex;
    if (!isParty && index >= 0) {
      this.combatants.splice(index, 1);
      if (index < this.turnIndex) this.turnIndex--;
      else if (wasActive) this.turnIndex--; // nextIndex() lo deja en el siguiente
    }

    const party = PartyComponent.find()?.getMembers() ?? [];
    const partyUp = party.some((m) => (m.getComponent('unit') as UnitComponent).isAlive());
    const enemiesLeft = this.combatants.some(
      (c) => c.unit.getFaction() === 'enemy' && c.unit.isAlive(),
    );
    if (!partyUp) this.endCombat('defeat');
    else if (!enemiesLeft) this.endCombat('victory');
    else if (wasActive) {
      this.nextIndex();
      this.beginTurn();
    }
  }

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
    if (!active || active.unit.isBusy() || this.pendingAttack || this.pendingHits.length) return;

    if (this.isPlayerTurn()) {
      if (Engine.getInput().isKeyJustPressed(KeyCode.SPACE)) {
        this.endTurn();
      } else if (!this.hasUsableResources(active.unit)) {
        this.endTurn(); // sin recursos
      }
    } else {
      // Hasta que haya IA (Fase 4): el enemigo pasa turno.
      this.turnTimer -= dt;
      if (this.turnTimer <= 0) this.endTurn();
    }
  }

  /** ¿Le queda algo que hacer? Metros, o una acción / acción adicional que algún ataque use. */
  private hasUsableResources(unit: UnitComponent): boolean {
    if (this.resources.movement >= EPS) return true;
    return unit.getAttacks().some((a) => this.resources[a.cost ?? 'action'] > 0);
  }

  /** Avanza al siguiente de la iniciativa (nueva ronda al dar la vuelta). */
  private nextIndex(): void {
    this.turnIndex++;
    if (this.turnIndex >= this.combatants.length) {
      this.turnIndex = 0;
      this.round++;
      this.emit('round', {});
    }
  }

  private beginTurn(): void {
    // Los caídos pierden el turno.
    for (let i = 0; i < this.combatants.length; i++) {
      if (this.combatants[this.turnIndex]?.unit.isAlive() !== false) break;
      this.nextIndex();
    }
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
    this.emit('turn', { unit: entity });
  }

  /** Un enemigo que entra a mitad de combate se coloca por su iniciativa. */
  private joinCombat(unit: UnitComponent): void {
    const combatant = this.rollInitiative(unit);
    let index = this.combatants.findIndex((c) => compareInitiative(combatant, c) < 0);
    if (index < 0) index = this.combatants.length;
    this.combatants.splice(index, 0, combatant);
    // Si entra antes (o en) la posición actual, la unidad activa no cambia: juega la ronda siguiente.
    if (index <= this.turnIndex) this.turnIndex++;
    this.emit('join', { unit: unit.getOwner() });
  }

  private rollInitiative(unit: UnitComponent): Combatant {
    return { unit, initiative: 1 + Math.floor(Math.random() * 20), tiebreak: Math.random() };
  }

  /** Primer enemigo vivo (fuera de `exclude`) que ve a algún miembro en pie de la party. */
  private findDetection(exclude: Set<UnitComponent>): { enemy: Entity; target: Entity } | null {
    const party = PartyComponent.find()?.getMembers() ?? [];
    for (const enemy of UnitComponent.getAll()) {
      const range = enemy.getSightRange();
      if (
        enemy.getFaction() !== 'enemy' ||
        range <= 0 ||
        !enemy.isAlive() ||
        exclude.has(enemy) ||
        this.disengaged.has(enemy)
      )
        continue;
      const eye = enemy.getPosition(this.tmpA);
      eye[1] = eye[1]! + EYE_HEIGHT;
      for (const member of party) {
        const unit = member.getComponent('unit') as UnitComponent;
        if (!unit.isAlive()) continue;
        const target = unit.getPosition(this.tmpB);
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
    // En combate las teclas numéricas son de la hotbar.
    PartyComponent.find()?.setNumberKeysEnabled(state !== 'combat');
    this.emit(`state:${state}`, {});
  }

  private emit(event: string, data: EncounterEventData): void {
    for (const l of this.listeners) l(event, data);
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
        busy: this.pendingAttack !== null || this.pendingHits.length > 0,
        units: UnitComponent.getAll().map((u) => ({
          name: u.getOwner().getName(),
          faction: u.getFaction(),
          hp: u.getHp(),
          maxHp: u.getMaxHp(),
          alive: u.isAlive(),
        })),
      }),
      command: (name, args) => {
        const unitArg = (key = 'unit'): Entity => {
          const ref = args[key];
          const entity =
            typeof ref === 'string'
              ? Engine.getEntities().getEntityByName(ref)
              : key === 'unit'
                ? this.getActingUnit()
                : null;
          if (!entity) throw new Error(`Unit not found: ${String(ref)}`);
          return entity;
        };
        const attackSummary = (r: AttackPlan) => ({
          attack: r.attack?.id ?? null,
          canAttack: r.canAttack,
          allowed: r.allowed,
          inRange: r.inRange,
          lineOfSight: r.lineOfSight,
          distance: r.distance,
          approach: r.approach ? r.approach.plan.length : null,
          hitChance: r.hitChance,
          damage: r.damage,
          reason: r.reason ?? null,
        });
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
          case 'attack': {
            const r = this.requestAttack(
              unitArg(),
              unitArg('target'),
              (args.attack as string | undefined) ?? null,
            );
            return { ok: r.ok, ...attackSummary(r) };
          }
          case 'plan_attack':
            return attackSummary(
              this.planAttack(
                unitArg(),
                unitArg('target'),
                (args.attack as string | undefined) ?? null,
              ),
            );
          case 'damage': {
            const target = unitArg();
            const ok = this.applyDamage(target, Number(args.amount ?? 1000));
            const unit = target.getComponent('unit') as UnitComponent;
            return { ok, hp: unit.getHp(), alive: unit.isAlive(), state: this.state };
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
          case 'restart':
            this.restart();
            return { state: this.state };
          case 'select':
            PartyComponent.find()?.select(unitArg(), 'code');
            return { selected: PartyComponent.find()?.getSelectedName() ?? null };
          default:
            throw new Error(
              `Unknown command '${name}'. Available: move, plan_move, attack, plan_attack, damage, end_turn, start_combat, end_combat, restart, select`,
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
