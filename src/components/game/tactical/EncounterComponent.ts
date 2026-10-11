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
import type { TacticalAIComponent } from './TacticalAIComponent';
import {
  hasLineOfSight,
  isOnNavMesh,
  planPath,
  truncatePath,
  type PathPlan,
} from './TacticalQueries';
import {
  EYE_HEIGHT,
  previewAttack,
  rollAttack,
  unitDistance,
  unitLineOfSight,
} from './CombatRules';
import { PropComponent, type PropExplosion } from './PropComponent';
import { Surfaces } from './Surfaces';
import { jumpArc, pushDistance } from './EnvironmentRules';
import {
  SkillCatalog,
  coneDirection,
  hasEffect,
  isHostile,
  unitsInCircle,
  unitsInCone,
  type SkillDef,
} from './Skills';

export type EncounterState = 'exploration' | 'combat' | 'victory' | 'defeat';

export type EncounterComponentDataType = Readonly<{
  /** Al empezar un combate entran los enemigos a esta distancia de la party (m). Default 15. */
  joinRadius?: number;
  /** Segundos que tarda en pasar turno un enemigo sin IA (tactical_ai). Default 0.8. */
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
  /** Origen del daño (texto flotante). */
  cause?: DamageCause;
}

export type DamageCause = 'attack' | 'skill' | 'fire' | 'explosion' | 'debug';

/** Objetivo de una habilidad: una unidad o un punto (según su targeting). */
export interface SkillTarget {
  unit?: Entity | null;
  point?: vec3 | null;
}

export interface SkillPlan {
  skill: SkillDef | null;
  /** La unidad puede actuar ahora (su turno, le queda el recurso, no está ocupada). */
  allowed: boolean;
  inRange: boolean;
  lineOfSight: boolean;
  /** Centro del efecto: el punto, la unidad objetivo o el lanzador (cono / self). */
  origin: vec3 | null;
  /** Cono: dirección (horizontal, normalizada). */
  direction: vec3 | null;
  /** Quién recibe los efectos (vista previa: se resaltan antes de confirmar). */
  affected: UnitComponent[];
  canCast: boolean;
  reason?: string;
}

export interface JumpPlan {
  /** La unidad puede actuar ahora (su turno, no está ocupada). */
  allowed: boolean;
  /** Trayectoria de los pies (vacía si no se puede). */
  points: vec3[];
  /** Distancia horizontal: los metros de movimiento que cuesta. */
  distance: number;
  canJump: boolean;
  reason?: string;
}

export interface PushPlan {
  /** La unidad puede actuar ahora (su turno, le queda la acción adicional). */
  allowed: boolean;
  /** Distancia de borde a borde al objeto (m). */
  distance: number;
  inReach: boolean;
  /** Dónde acabará el objeto (pies) y cuánto se desplaza. */
  destination: vec3 | null;
  pushLength: number;
  canPush: boolean;
  reason?: string;
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
/** Un turno de la IA que dure más que esto (s simulados) se da por terminado. */
const AI_TURN_TIMEOUT = 20;
/** Al acercarse para atacar cuerpo a cuerpo se queda a esta fracción del alcance. */
const APPROACH_FRACTION = 0.6;
const APPROACH_CANDIDATES = 16;
/** Daño al entrar en fuego o empezar el turno dentro. */
const FIRE_DAMAGE = 5;
const JUMP_SPEED = 7;
const JUMP_CLIP = 'Jump_Loop';
/** Alcance para empujar un objeto (de borde a borde, m). */
const PUSH_REACH = 1.5;
const PUSH_SPEED = 5;
const PUSH_TIME = 0.6;
const PUSH_CLIP = 'Push_Enter';
/** Duración de lanzar una habilidad (la unidad está ocupada) y momento del efecto. */
const SKILL_TIME = 0.9;
const SKILL_DELAY = 0.45;
/** Altura sobre un punto del suelo a la que se comprueba la línea de visión (se ve la zona). */
const POINT_AIM_HEIGHT = 1;
const DASH_SPEED = 16;
const SHOVE_SPEED = 8;
/** Altura (sobre los pies) a la que se comprueba que el camino de una embestida está libre. */
const DASH_CLEARANCE = 1;

/**
 * EncounterComponent — máquina de estados del juego táctico y combate por turnos.
 *
 *   exploration ──(un enemigo ve a la party / la party ataca)──▶ combat ──▶ victory ──▶ exploration
 *        ▲                                                            └──▶ defeat ──(R)──┘
 *
 * Combate: iniciativa d20 (RNG del juego, reproducible con ?seed), rondas, recursos por
 * turno (acción, acción adicional, metros), fin de turno manual (Espacio / botón) o
 * automático sin recursos útiles, y enemigos que se unen a mitad de combate. En el turno
 * de un enemigo con tactical_ai decide su IA (Behavior Tree); sin ella, pasa turno.
 *
 * Ataques: cuerpo a cuerpo (si no llega, se acerca y ataca) y a distancia (alcance y línea
 * de visión). A 0 PV un enemigo muere (sale de la iniciativa) y un aliado queda caído
 * (pierde sus turnos; se levanta con 1 PV al ganar). Sin enemigos vivos → victoria; toda
 * la party caída → derrota. R reinicia el encuentro (derrota o mapa despejado).
 *
 * Entorno: saltar (gasta metros de movimiento) por encima de cajas y muros bajos; empujar
 * objetos (gasta la acción adicional); barriles que explotan al destruirse (daño en área y
 * fuego); fuego que quema al entrar o al empezar el turno dentro; aceite que prende.
 *
 * Es quien aplica las reglas (planMove / planAttack / planJump / planPush y sus request*) para que
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
  /** Segundos que lleva el turno de la IA (vigilante). */
  private aiTurnTime = 0;
  /** Turnos de la IA cortados por el vigilante (debería ser siempre 0). */
  private aiTimeouts = 0;
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
  /** Habilidades lanzadas cuyo efecto aún no ha llegado (sincronizado con la animación). */
  private pendingSkills: { timer: number; caster: UnitComponent; plan: SkillPlan }[] = [];
  /** Enemigos de combates terminados por comando (end_combat): no vuelven a detectar. */
  private disengaged = new Set<UnitComponent>();
  private surfaces = new Surfaces();
  /** Unidades que estaban dentro de un fuego el frame anterior (quemar solo al entrar). */
  private inFire = new Set<UnitComponent>();
  private initialized = false;

  private readonly tmpA = vec3.create();
  private readonly tmpB = vec3.create();

  public async load(data: EncounterComponentDataType): Promise<void> {
    this.joinRadius = data.joinRadius ?? this.joinRadius;
    this.enemyTurnDelay = data.enemyTurnDelay ?? this.enemyTurnDelay;
    this.victoryTime = data.victoryTime ?? this.victoryTime;
    if (!ModuleGameController.gameplayHuds.includes('COMBAT_HUD')) {
      ModuleGameController.gameplayHuds.push('COMBAT_HUD');
    }
    await SkillCatalog.load();
  }

  public update(dt: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.registerDevCommands();
    }
    this.surfaces.init();

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

    this.surfaces.update(dt, this.state === 'combat');
    this.updateFire();

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
  /** Hay un ataque en marcha (acercándose para atacar o un golpe por resolver). */
  public isResolving(): boolean {
    return (
      this.pendingAttack !== null || this.pendingHits.length > 0 || this.pendingSkills.length > 0
    );
  }

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

  // ── Entorno: saltar y empujar (reglas compartidas por jugador, MCP e IA) ──

  /** ¿Puede `entity` saltar hasta `destination` (punto del suelo)? Cuesta los metros saltados. */
  public planJump(entity: Entity, destination: vec3): JumpPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const result: JumpPlan = { allowed: false, points: [], distance: 0, canJump: false };
    const fail = (reason: string): JumpPlan => ({ ...result, reason });
    if (!unit) return fail('not a unit');
    if (!unit.hasAbility('jump')) return fail('cannot jump');
    const permission = this.canAct(unit, null);
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    const arc = jumpArc(unit.getFeetPosition(this.tmpA), destination);
    if ('reason' in arc) return fail(arc.reason);
    result.points = arc.points;
    result.distance = arc.distance;
    if (this.state === 'combat' && arc.distance > this.resources.movement + EPS) {
      return fail('not enough movement');
    }
    result.canJump = true;
    return result;
  }

  public requestJump(entity: Entity, destination: vec3): JumpPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planJump(entity, destination);
    if (!plan.canJump) return { ...plan, ok: false };
    if (this.state === 'combat') {
      this.resources.movement = Math.max(0, this.resources.movement - plan.distance);
    }
    this.pendingAttack = null;
    const unit = entity.getComponent('unit') as UnitComponent;
    const last = plan.points[plan.points.length - 1]!;
    unit.faceTowards(vec3.fromValues(last[0]!, unit.getPosition(this.tmpA)[1]!, last[2]!));
    unit.playAction(JUMP_CLIP);
    void unit.moveAlong(plan.points, { speed: JUMP_SPEED, walk: false, face: false });
    this.emit('jump', { unit: entity });
    return { ...plan, ok: true };
  }

  /** ¿Puede `entity` empujar el objeto `target`? Cuesta la acción adicional. */
  public planPush(entity: Entity, target: Entity): PushPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const prop = target.getComponent('unit') as UnitComponent | null;
    const result: PushPlan = {
      allowed: false,
      distance: Infinity,
      inReach: false,
      destination: null,
      pushLength: 0,
      canPush: false,
    };
    const fail = (reason: string): PushPlan => ({ ...result, reason });
    if (!unit || !prop) return fail('not a unit');
    if (!unit.hasAbility('push')) return fail('cannot push');
    const data = PropComponent.of(target);
    if (!data?.isPushable() || !prop.isAlive()) return fail('not pushable');
    result.distance = unitDistance(unit, prop);
    result.inReach = result.distance <= PUSH_REACH + EPS;
    const permission = this.canAct(unit, 'bonusAction');
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    if (!result.inReach) return fail('too far to push');

    const from = unit.getPosition(this.tmpA);
    const to = prop.getPosition(this.tmpB);
    const dir = vec3.fromValues(to[0]! - from[0]!, 0, to[2]! - from[2]!);
    if (vec3.length(dir) < 1e-4) return fail('too far to push');
    vec3.normalize(dir, dir);
    const length = pushDistance(prop, dir, data.getPushDistance());
    if (length < 0.3) return fail('push blocked');
    result.pushLength = length;
    result.destination = vec3.scaleAndAdd(vec3.create(), prop.getFeetPosition(), dir, length);
    result.canPush = true;
    return result;
  }

  public requestPush(entity: Entity, target: Entity): PushPlan & { ok: boolean } {
    const plan = this.planPush(entity, target);
    if (!plan.canPush || !plan.destination) return { ...plan, ok: false };
    if (this.state === 'combat') {
      this.resources.bonusAction = Math.max(0, this.resources.bonusAction - 1);
    }
    const unit = entity.getComponent('unit') as UnitComponent;
    const prop = target.getComponent('unit') as UnitComponent;
    unit.faceTowards(prop.getPosition(this.tmpA));
    unit.playAction(PUSH_CLIP, PUSH_TIME);
    void prop.moveAlong([prop.getFeetPosition(), plan.destination], {
      speed: PUSH_SPEED,
      walk: false,
      face: false,
    });
    this.emit('push', { unit: target, source: entity });
    return { ...plan, ok: true };
  }

  public getSurfaces(): Surfaces {
    return this.surfaces;
  }

  // ── Habilidades (reglas compartidas por jugador, MCP e IA) ────────────────

  /**
   * ¿Puede `entity` lanzar la habilidad `skillId` sobre `target`? Calcula también el área y
   * quién queda afectado, aunque no se pueda lanzar (vista previa).
   */
  public planSkill(entity: Entity, skillId: string, target: SkillTarget = {}): SkillPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const skill = SkillCatalog.get(skillId);
    const result: SkillPlan = {
      skill,
      allowed: false,
      inRange: false,
      lineOfSight: false,
      origin: null,
      direction: null,
      affected: [],
      canCast: false,
    };
    const fail = (reason: string): SkillPlan => ({ ...result, canCast: false, reason });
    if (!unit) return fail('not a unit');
    if (!skill || !unit.hasSkill(skillId)) return fail(`unknown skill '${skillId}'`);

    const feet = unit.getFeetPosition(vec3.create());
    const targetUnit = (target.unit?.getComponent('unit') as UnitComponent | null) ?? null;
    switch (skill.target) {
      case 'self':
        result.origin = feet;
        result.inRange = result.lineOfSight = true;
        result.affected =
          skill.radius > 0 ? unitsInCircle(skill, unit, feet, skill.radius) : [unit];
        break;
      case 'unit': {
        if (!targetUnit) return fail('no target');
        result.origin = targetUnit.getFeetPosition(vec3.create());
        const ally = targetUnit.getFaction() === unit.getFaction();
        if (skill.targets === 'ally' && !ally) return fail('target must be an ally');
        if (skill.targets === 'enemy' && ally) return fail('target must be an enemy');
        const revive = ally && hasEffect(skill, 'heal');
        if (!targetUnit.isAlive() && !revive) return fail('target is down');
        const self = targetUnit === unit;
        result.inRange = self || unitDistance(unit, targetUnit) <= skill.range + EPS;
        result.lineOfSight = self || !skill.lineOfSight || unitLineOfSight(unit, targetUnit);
        result.affected =
          skill.radius > 0 ? unitsInCircle(skill, unit, result.origin, skill.radius) : [targetUnit];
        break;
      }
      case 'point': {
        const point = target.point ?? targetUnit?.getFeetPosition(vec3.create()) ?? null;
        if (!point) return fail('no target');
        result.origin = vec3.clone(point);
        const center = unit.getPosition(this.tmpA);
        result.inRange =
          Math.hypot(point[0]! - center[0]!, point[2]! - center[2]!) <= skill.range + EPS;
        const eye = vec3.fromValues(center[0]!, center[1]! + EYE_HEIGHT, center[2]!);
        const aim = vec3.fromValues(point[0]!, point[1]! + POINT_AIM_HEIGHT, point[2]!);
        result.lineOfSight = !skill.lineOfSight || hasLineOfSight(eye, aim);
        result.affected = skill.radius > 0 ? unitsInCircle(skill, unit, point, skill.radius) : [];
        if (hasEffect(skill, 'teleport')) {
          result.affected = [unit];
          if (!isOnNavMesh(point[0]!, point[1]!, point[2]!, 0.3)) return fail('cannot land there');
          const a = vec3.fromValues(feet[0]!, feet[1]! + DASH_CLEARANCE, feet[2]!);
          const b = vec3.fromValues(point[0]!, point[1]! + DASH_CLEARANCE, point[2]!);
          if (!hasLineOfSight(a, b)) return fail('path blocked');
        }
        break;
      }
      case 'cone': {
        const point = target.point ?? targetUnit?.getFeetPosition(vec3.create()) ?? null;
        if (!point) return fail('no target');
        result.origin = feet;
        result.direction = coneDirection(feet, point);
        result.inRange = result.lineOfSight = true;
        result.affected = unitsInCone(skill, unit, point);
        break;
      }
    }

    if (!result.inRange) return fail('target out of range');
    if (!result.lineOfSight) return fail('no line of sight');
    const permission = this.canAct(unit, skill.cost);
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    if (this.state === 'combat' && unit.getCooldown(skill.id) > 0) return fail('on cooldown');
    result.canCast = true;
    return result;
  }

  /** Lanza la habilidad si las reglas lo permiten (gasta su recurso y empieza su cooldown). */
  public requestSkill(
    entity: Entity,
    skillId: string,
    target: SkillTarget = {},
  ): SkillPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planSkill(entity, skillId, target);
    if (!plan.canCast || !plan.skill || !plan.origin) return { ...plan, ok: false };
    const skill = plan.skill;
    const unit = entity.getComponent('unit') as UnitComponent;
    if (this.state === 'combat') {
      this.resources[skill.cost] = Math.max(0, this.resources[skill.cost] - 1);
      unit.setCooldown(skill.id, skill.cooldown);
    }
    this.pendingAttack = null;
    this.emit('skill', { unit: entity });

    if (hasEffect(skill, 'teleport')) {
      // Embestida: en línea recta, muy rápido; no gasta movimiento.
      unit.faceTowards(plan.origin);
      void unit.moveAlong([unit.getFeetPosition(), plan.origin], {
        speed: DASH_SPEED,
        walk: false,
      });
      return { ...plan, ok: true };
    }

    if (skill.target === 'cone' && plan.direction) {
      const p = unit.getPosition(this.tmpA);
      unit.faceTowards(vec3.scaleAndAdd(this.tmpB, p, plan.direction, 1));
    } else if (skill.target !== 'self') {
      unit.faceTowards(plan.origin);
    }
    unit.playAction(skill.clip, SKILL_TIME);
    this.pendingSkills.push({ timer: SKILL_DELAY, caster: unit, plan });
    return { ...plan, ok: true };
  }

  /** Efectos de una habilidad al llegar el momento del impacto. */
  private applySkill(caster: UnitComponent, plan: SkillPlan): void {
    const skill = plan.skill!;
    const origin = plan.origin!;
    const affected = () => plan.affected.filter((u) => u.isAlive() || hasEffect(skill, 'heal'));
    for (const effect of skill.effects) {
      switch (effect.type) {
        case 'damage':
          for (const u of affected()) {
            if (u.isAlive()) this.applyHit(caster, u, true, effect.amount, 'skill');
          }
          break;
        case 'heal':
          for (const u of affected()) this.healUnit(u, effect.amount);
          break;
        case 'push': {
          // Lejos del lanzador (cono, unidad) o del centro del área (punto).
          const from = skill.target === 'point' ? origin : caster.getFeetPosition(vec3.create());
          for (const u of affected()) {
            if (u === caster || !u.isAlive()) continue;
            const feet = u.getFeetPosition(vec3.create());
            const dir = coneDirection(from, feet);
            if (Math.hypot(feet[0]! - from[0]!, feet[2]! - from[2]!) < 1e-3 && plan.direction) {
              vec3.copy(dir, plan.direction);
            }
            const length = pushDistance(u, dir, effect.distance);
            if (length < 0.1) continue;
            u.stop();
            void u.moveAlong([feet, vec3.scaleAndAdd(vec3.create(), feet, dir, length)], {
              speed: SHOVE_SPEED,
              walk: false,
              face: false,
            });
            this.emit('pushed', { unit: u.getOwner(), source: caster.getOwner() });
          }
          break;
        }
        case 'surface':
          this.surfaces.add(effect.surface, origin, effect.radius);
          break;
        case 'teleport':
          break; // se resuelve al lanzar
      }
    }

    // Una habilidad hostil contra un enemigo empieza el combate (también si solo empuja).
    const enemy = plan.affected.find((u) => u.getFaction() === 'enemy' && u.isAlive());
    if (
      this.state === 'exploration' &&
      caster.getFaction() === 'party' &&
      isHostile(skill) &&
      enemy
    ) {
      this.startCombat(enemy.getOwner());
    }
  }

  /** Cura (y levanta a un aliado caído). */
  private healUnit(unit: UnitComponent, amount: number): void {
    const health = unit.getHealth();
    if (!health) return;
    if (!unit.isAlive()) {
      if (!PartyComponent.find()?.isMember(unit.getOwner())) return;
      unit.setDown(false, amount);
      this.emit('revive', { unit: unit.getOwner() });
      this.emit('heal', { unit: unit.getOwner(), amount: unit.getHp() });
      return;
    }
    const before = health.getHp();
    health.heal(amount);
    this.emit('heal', { unit: unit.getOwner(), amount: health.getHp() - before });
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
    for (const u of UnitComponent.getAll()) u.clearCooldowns();
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
    this.pendingSkills = [];
    this.disengaged.clear();
    this.round = 0;
    this.turnIndex = 0;
    for (const unit of UnitComponent.getAll()) unit.resetToSpawn();
    this.surfaces.reset();
    this.inFire.clear();
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
    const attacker = source?.getComponent('unit') as UnitComponent | null;
    this.applyHit(attacker, target, true, amount, 'debug');
    return true;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** null si la unidad puede actuar ahora gastando `cost` (null: sin coste); si no, el motivo. */
  private canAct(unit: UnitComponent, cost: 'action' | 'bonusAction' | null): string | null {
    if (!unit.isAlive()) return 'unit is down';
    if (unit.isBusy() || this.pendingAttack) return 'unit is busy';
    const entity = unit.getOwner();
    if (this.state === 'combat') {
      if (entity !== this.getActiveUnit()) return 'not this unit’s turn';
      if (cost && this.resources[cost] <= 0)
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

    if (this.pendingSkills.length) {
      const ready = this.pendingSkills.filter((p) => (p.timer -= dt) <= 0);
      this.pendingSkills = this.pendingSkills.filter((p) => p.timer > 0);
      for (const p of ready) this.applySkill(p.caster, p.plan);
    }

    if (this.pendingHits.length === 0) return;
    const due: PendingHit[] = [];
    this.pendingHits = this.pendingHits.filter((h) => {
      h.timer -= dt;
      if (h.timer > 0) return true;
      due.push(h);
      return false;
    });
    for (const h of due) this.applyHit(h.attacker, h.target, h.hit, h.damage, 'attack');
  }

  private applyHit(
    attacker: UnitComponent | null,
    target: UnitComponent,
    hit: boolean,
    damage: number,
    cause: DamageCause,
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
      cause,
    });

    if (health && health.getHp() <= 0) this.onUnitDown(target, attacker);
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

  /**
   * Vida a 0: el enemigo muere y sale de la iniciativa; el aliado queda caído; un objeto se
   * destruye (y si es explosivo, explota). `instigator`: quien lo causó (también en cadena).
   */
  private onUnitDown(unit: UnitComponent, instigator: UnitComponent | null = null): void {
    unit.setDown(true);
    this.inFire.delete(unit);
    const prop = PropComponent.of(unit.getOwner());
    if (prop) {
      this.emit('destroyed', { unit: unit.getOwner() });
      const explosion = prop.getExplosion();
      if (explosion) this.explode(unit, explosion, instigator);
      return;
    }
    const isParty = PartyComponent.find()?.isMember(unit.getOwner()) === true;
    this.emit(isParty ? 'downed' : 'death', { unit: unit.getOwner() });
    this.checkCombatEnd(unit, isParty);
  }

  /** Daño en área alrededor de un objeto explosivo (en cadena) y la superficie que deja. */
  private explode(
    prop: UnitComponent,
    explosion: PropExplosion,
    instigator: UnitComponent | null,
  ): void {
    const center = prop.getFeetPosition(vec3.create());
    this.surfaces.spawnExplosion(center);
    this.emit('explosion', { unit: prop.getOwner(), source: instigator?.getOwner() ?? null });
    const p = vec3.create();
    for (const u of UnitComponent.getAll()) {
      if (u === prop || !u.isAlive()) continue;
      u.getFeetPosition(p);
      const d = Math.hypot(p[0]! - center[0]!, p[2]! - center[2]!) - u.getCapsuleRadius();
      if (d <= explosion.radius && Math.abs(p[1]! - center[1]!) < 2) {
        this.applyHit(instigator, u, true, explosion.damage, 'explosion');
      }
    }
    if (explosion.surface) {
      this.surfaces.add(explosion.surface, center, explosion.surfaceRadius ?? explosion.radius);
    }
    this.surfaces.igniteAround(center, explosion.radius);
  }

  /** Tras una baja: fin del combate (victoria / derrota) o pasar el turno si era el activo. */
  private checkCombatEnd(unit: UnitComponent, isParty: boolean): void {
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
    if (!active) return;

    // Vigilante: un turno de la IA nunca se queda colgado (camino imposible, bug…).
    const ai = this.getAI(active.unit);
    if (ai) {
      this.aiTurnTime += dt;
      if (this.aiTurnTime > AI_TURN_TIMEOUT) {
        console.warn(`[Encounter] AI turn of ${active.unit.getOwner().getName()} timed out`);
        this.aiTimeouts++;
        active.unit.stop();
        this.pendingAttack = null;
        this.pendingHits = [];
        this.endTurn();
        return;
      }
    }

    if (active.unit.isBusy() || this.isResolving()) return;

    if (this.isPlayerTurn()) {
      if (Engine.getInput().isKeyJustPressed(KeyCode.SPACE)) {
        this.endTurn();
      } else if (!this.hasUsableResources(active.unit)) {
        this.endTurn(); // sin recursos
      }
    } else if (ai) {
      if (ai.updateTurn(dt)) this.endTurn();
    } else {
      // Sin IA (enemigo dummy): pasa turno.
      this.turnTimer -= dt;
      if (this.turnTimer <= 0) this.endTurn();
    }
  }

  private getAI(unit: UnitComponent): TacticalAIComponent | null {
    if (PartyComponent.find()?.isMember(unit.getOwner())) return null;
    return unit.getOwner().getComponent('tactical_ai') as TacticalAIComponent | null;
  }

  /**
   * ¿Le queda algo que hacer? Metros, una acción / acción adicional que algún ataque use, o
   * la acción adicional para empujar un objeto que tenga al alcance.
   */
  private hasUsableResources(unit: UnitComponent): boolean {
    if (this.resources.movement >= EPS) return true;
    if (unit.getAttacks().some((a) => this.resources[a.cost ?? 'action'] > 0)) return true;
    // Habilidades sobre uno mismo: siempre tienen objetivo.
    const selfSkill = unit.getSkillIds().some((id) => {
      const skill = SkillCatalog.get(id);
      return (
        skill?.target === 'self' && this.resources[skill.cost] > 0 && unit.getCooldown(id) === 0
      );
    });
    if (selfSkill) return true;
    return (
      this.resources.bonusAction > 0 &&
      unit.hasAbility('push') &&
      UnitComponent.getAll().some((u) => this.planPush(unit.getOwner(), u.getOwner()).canPush)
    );
  }

  /** Fuego: quema a quien entra (también a los objetos: un barril explota). */
  private updateFire(): void {
    const p = vec3.create();
    for (const u of UnitComponent.getAll()) {
      const inside =
        u.isAlive() && this.surfaces.fireAt(u.getFeetPosition(p), u.getCapsuleRadius());
      if (inside && !this.inFire.has(u)) {
        this.inFire.add(u);
        this.burn(u);
      } else if (!inside) {
        this.inFire.delete(u);
      }
    }
  }

  private burn(unit: UnitComponent): void {
    if (unit.isAlive() && unit.getHealth()) this.applyHit(null, unit, true, FIRE_DAMAGE, 'fire');
  }

  /** Avanza al siguiente de la iniciativa (nueva ronda al dar la vuelta). */
  private nextIndex(): void {
    this.turnIndex++;
    if (this.turnIndex >= this.combatants.length) {
      this.turnIndex = 0;
      this.round++;
      this.surfaces.onRound();
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
    this.aiTurnTime = 0;
    active.unit.tickCooldowns();
    this.getAI(active.unit)?.beginTurn(this);

    const entity = active.unit.getOwner();
    const party = PartyComponent.find();
    if (party?.isMember(entity)) {
      party.select(entity, 'code'); // la cámara lo sigue
    } else {
      this.getCamera()?.focusOn(entity, true);
    }
    this.emit('turn', { unit: entity });
    // Empezar el turno dentro del fuego quema.
    const feet = active.unit.getFeetPosition(this.tmpA);
    if (this.surfaces.fireAt(feet, active.unit.getCapsuleRadius())) this.burn(active.unit);
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
        busy: this.isResolving(),
        aiTimeouts: this.aiTimeouts,
        surfaces: this.surfaces.getAll().map((sf) => ({
          type: sf.type,
          center: Array.from(sf.center).map((v) => Math.round(v * 100) / 100),
          radius: sf.radius,
          rounds: Number.isFinite(sf.rounds) ? sf.rounds : null,
        })),
        aiPlans: UnitComponent.getAll()
          .map((u) => ({ unit: u, plan: this.getAI(u)?.getLastPlan() ?? null }))
          .filter((p) => p.plan)
          .map((p) => ({
            unit: p.unit.getOwner().getName(),
            kind: p.plan!.kind,
            reason: p.plan!.reason,
            score: Math.round(p.plan!.score * 10) / 10,
          })),
        units: UnitComponent.getAll().map((u) => ({
          name: u.getOwner().getName(),
          faction: u.getFaction(),
          hp: u.getHp(),
          maxHp: u.getMaxHp(),
          alive: u.isAlive(),
          cooldowns: Object.fromEntries(
            u
              .getSkillIds()
              .map((id) => [id, u.getCooldown(id)])
              .filter(([, cd]) => cd),
          ),
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
          case 'jump':
          case 'plan_jump': {
            const to = args.to as [number, number, number] | undefined;
            if (!Array.isArray(to)) throw new Error(`${name} needs args.to = [x, y, z]`);
            const dest = vec3.fromValues(to[0], to[1], to[2]);
            const r =
              name === 'jump'
                ? this.requestJump(unitArg(), dest)
                : { ...this.planJump(unitArg(), dest), ok: null };
            return {
              ok: r.ok,
              canJump: r.canJump,
              allowed: r.allowed,
              distance: r.distance,
              apex: r.points.length ? Math.max(...r.points.map((q) => q[1]!)) : null,
              reason: r.reason ?? null,
            };
          }
          case 'push':
          case 'plan_push': {
            const r =
              name === 'push'
                ? this.requestPush(unitArg(), unitArg('target'))
                : { ...this.planPush(unitArg(), unitArg('target')), ok: null };
            return {
              ok: r.ok,
              canPush: r.canPush,
              allowed: r.allowed,
              inReach: r.inReach,
              distance: r.distance,
              pushLength: r.pushLength,
              destination: r.destination ? Array.from(r.destination) : null,
              reason: r.reason ?? null,
            };
          }
          case 'skill':
          case 'plan_skill': {
            const skillId = String(args.skill ?? '');
            const to = args.to as [number, number, number] | undefined;
            const target: SkillTarget = {
              unit: typeof args.target === 'string' ? unitArg('target') : null,
              point: Array.isArray(to) ? vec3.fromValues(to[0], to[1], to[2]) : null,
            };
            const r =
              name === 'skill'
                ? this.requestSkill(unitArg(), skillId, target)
                : { ...this.planSkill(unitArg(), skillId, target), ok: null };
            return {
              ok: r.ok,
              canCast: r.canCast,
              allowed: r.allowed,
              inRange: r.inRange,
              lineOfSight: r.lineOfSight,
              affected: r.affected.map((u) => u.getOwner().getName()),
              reason: r.reason ?? null,
            };
          }
          case 'restart':
            this.restart();
            return { state: this.state };
          case 'select':
            PartyComponent.find()?.select(unitArg(), 'code');
            return { selected: PartyComponent.find()?.getSelectedName() ?? null };
          default:
            throw new Error(
              `Unknown command '${name}'. Available: move, plan_move, attack, plan_attack, jump, plan_jump, push, plan_push, skill, plan_skill, damage, end_turn, start_combat, end_combat, restart, select`,
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
