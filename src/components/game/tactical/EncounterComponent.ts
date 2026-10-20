import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { DevBridge } from '../../../core/debug/DevBridge';
import { ModuleGameController } from '../../../modules/game/ModuleGameController';
import { Zones, type TimeBubble } from './Zones';
import { SpiritZones } from './SpiritZones';
import { Cover, rayToProp } from './Cover';
import {
  RHYTHM_MAX,
  UnitComponent,
  type StatusOptions,
  type UnitAttack,
  type UnitStatusId,
} from './UnitComponent';
import { PartyComponent } from './PartyComponent';
import { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { ActionCameraComponent } from './ActionCameraComponent';
import { UnitObstacles } from './UnitObstacles';
import { CharacterSheetController } from '../../../core/ui/controllers/CharacterSheetController';
import type { TacticalAIComponent } from './TacticalAIComponent';
import {
  groundHeightAt,
  hasLineOfSight,
  isOnNavMesh,
  planPath,
  truncatePath,
  type PathPlan,
} from './TacticalQueries';
import {
  EYE_HEIGHT,
  STEEL_BUBBLE_MISS,
  damageDealtMultiplier,
  finisherDamage,
  hitRange,
  isMetallic,
  metalCost,
  previewAttack,
  rollAttack,
  skillDamage,
  unitDistance,
  unitDistanceFrom,
  unitLineOfSight,
  unitLineOfSightFrom,
} from './CombatRules';
import { IMPACT_BASE, PropComponent, type PropExplosion } from './PropComponent';
import { Surfaces } from './Surfaces';
import {
  MAX_JUMP,
  THROW_RANGE,
  flightHit,
  jumpArc,
  pushDistance,
  pushPath,
  throwArc,
} from './EnvironmentRules';
import { rollInitiative, rollRange, steelDistanceFor, steelJumpFor } from './Stats';
import {
  SkillCatalog,
  coneDirection,
  hasEffect,
  isAnchoredBubble,
  isHostile,
  isMetalAction,
  lineReach,
  unitsInCircle,
  unitsInCone,
  unitsInLine,
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
  /** Golpe crítico (evento damage). */
  crit?: boolean;
  /** Origen del daño (texto flotante). */
  cause?: DamageCause;
  /** Estado aplicado o expirado (eventos status / status-end). */
  status?: UnitStatusId;
}

export type DamageCause = 'attack' | 'skill' | 'fire' | 'explosion' | 'impact' | 'debug';

/**
 * Lo que mueve una habilidad: el objetivo empujado o atraído (en línea recta), el lanzador
 * saltando (en arco) o el arma que le quitan a alguien (desarme, sin movimiento).
 */
export interface SkillMotion {
  kind: 'push' | 'pull' | 'leap' | 'disarm' | 'hurl';
  /** Lo que se mueve: el objetivo o, en un salto, el lanzador. */
  body: UnitComponent;
  /** Trayectoria de sus pies (vacía en un desarme). */
  points: vec3[];
  /** Contra quién choca al llegar (recibe el IMPACTO). */
  hit: UnitComponent | null;
  /** Se para contra una pared o un desnivel (una unidad recibe +50 %). */
  wall: boolean;
  /** D del impacto: base del tamaño (una unidad cuenta como Grande) + POT, por el multiplicador. */
  damage: number;
}

/** Objetivo de una habilidad: una unidad o un punto (según su targeting). */
export interface SkillTarget {
  unit?: Entity | null;
  point?: vec3 | null;
  /** Empuje: hacia dónde (horizontal); se ajusta al ángulo que permite la habilidad. */
  direction?: vec3 | null;
  /** Lanzar: la unidad junto a la que cae (y a la que golpea); si no, en `point`. */
  toUnit?: Entity | null;
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
  /** Línea: hasta dónde llega (se corta en la primera pared). */
  reach: number;
  /** Burbuja de bendaleo con la suya activa: lanzarla la cierra. */
  closesBubble?: boolean;
  /** Empuje, tirón, desarme o salto: qué se mueve y por dónde (vista previa). */
  motion: SkillMotion | null;
  /** Pulso de ettmetal: todo lo que sale despedido a la vez. */
  motions: SkillMotion[];
  /**
   * Conexión: quién recibiría también los estados (de su bando, en la misma zona que un
   * afectado). No reciben daño ni el resto de efectos.
   */
  connected: UnitComponent[];
  /** Metal que gastaría de la Reserva (con duraluminio, nada). */
  metalCost: number;
  /** Multiplicador del efecto (duraluminio: ×(1 + quemado / máximo)). */
  power: number;
  /** Fuera de alcance o sin visión: andar hasta aquí antes de lanzarla. */
  approach: MovePlan | null;
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
  /** Desde aquí no llega: andar hasta este punto de despegue (los metros se suman al salto). */
  approach: MovePlan | null;
  canJump: boolean;
  reason?: string;
}

export interface PushPlan {
  /** La unidad puede actuar ahora (su turno, le queda la acción adicional). */
  allowed: boolean;
  /** Fuera de alcance: andar hasta aquí antes de empujar. */
  approach: MovePlan | null;
  /** Distancia de borde a borde al objeto (m). */
  distance: number;
  inReach: boolean;
  /** Dónde acabará el objeto (pies) y cuánto se desplaza. */
  destination: vec3 | null;
  pushLength: number;
  /** Hacia dónde sale (horizontal, normalizada): la elegida o, si no, alejándolo. */
  direction: vec3 | null;
  /** Contra quién choca (recibe el impacto; el objeto también). */
  hit: UnitComponent | null;
  /** Daño del impacto contra la armadura del golpeado: 0 si no choca con nadie. */
  minDamage: number;
  maxDamage: number;
  canPush: boolean;
  reason?: string;
}

export interface ThrowPlan {
  /** La unidad puede actuar ahora (su turno, le queda la acción). */
  allowed: boolean;
  /** Lejos del objeto o del destino: andar hasta aquí antes de lanzar. */
  approach: MovePlan | null;
  /** Trayectoria del objeto (sus pies), hasta donde cae. */
  points: vec3[];
  landing: vec3 | null;
  /** A quién golpea (el objetivo o lo primero que pille en medio). */
  hit: UnitComponent | null;
  /** Daño del impacto contra la armadura del golpeado (o el del objeto, si no golpea). */
  minDamage: number;
  maxDamage: number;
  canThrow: boolean;
  reason?: string;
}

/**
 * Un objeto (o una unidad) empujado, atraído o lanzado que golpea al llegar, a quien pille y a
 * sí mismo (GDD §5).
 */
interface PendingImpact {
  timer: number;
  source: UnitComponent;
  /** Lo que se mueve: un objeto o una unidad. */
  body: UnitComponent;
  hit: UnitComponent | null;
  /** D del impacto (el golpeado lo recibe con su armadura). */
  damage: number;
  /** El objeto se golpea aunque no pille a nadie (lanzado: cae al suelo). */
  always: boolean;
  /** Hacia dónde iba (horizontal): el golpeado sale despedido hacia allí. */
  direction: vec3 | null;
  /** Lo que se mueve es una unidad: llega Derribada (y recibe daño si choca). */
  unitBody: boolean;
  /** Se ha parado contra una pared (una unidad recibe +50 %). */
  wall: boolean;
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
  /** Daño medio, mínimo y máximo si impacta (sin crítico). */
  damage: number;
  minDamage: number;
  maxDamage: number;
  /** Daño del crítico (máx × 1,5, ignora la armadura). */
  critDamage: number;
  /** Probabilidad (0-1) de crítico si impacta en el próximo ataque del atacante (bolsa de canicas). */
  critChance: number;
  reason?: string;
}

interface PendingHit {
  timer: number;
  attacker: UnitComponent;
  target: UnitComponent;
  hit: boolean;
  crit: boolean;
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
/** A distancia: anillos (fracciones del alcance) donde buscar sitio con visión. */
const RANGED_RINGS = [0.85, 0.6, 0.35];
/** Saltar: anillos (fracciones del salto máximo) donde buscar el punto de despegue. */
const JUMP_RINGS = [0.97, 0.85, 0.6, 0.35];
/** Saltar: diferencia de altura (m) para considerar que un despegue está en el mismo nivel. */
const SAME_LEVEL = 0.4;
/** Daño al entrar en fuego o empezar el turno dentro. */
const FIRE_DAMAGE = 5;
const JUMP_SPEED = 7;
const JUMP_CLIP = 'Jump_Loop';
/** Alcance para empujar un objeto (de borde a borde, m). */
const PUSH_REACH = 1.5;
/** Velocidad con la que sale el objeto empujado (m/s); frena hasta pararse a su pushDistance. */
const PUSH_SPEED = 14;
const PUSH_TIME = 0.7;
const PUSH_CLIP = 'Push_Enter';
/** Desde que empieza la animación de empujar hasta que las manos tocan el objeto (s). */
const PUSH_CONTACT = 0.22;
/** Giro máximo del objeto mientras resbala (rad). */
const PUSH_SPIN = 0.5;
/** El golpeado por un objeto sale despedido unos metros, deprisa. */
const KNOCKBACK = 0.9;
const KNOCKBACK_SPEED = 9;
/** Sacudida de la cámara de acción (m): objeto que choca con alguien / contra una pared. */
const SHAKE_HIT = 0.14;
const SHAKE_THUD = 0.05;
/** Astillas de un objeto que se rompe (sin explosión). */
const DEBRIS_PREFAB = 'tactical/crate_debris.prefab';
const DEBRIS_LIFETIME = 1.6;
/** Empujar en una dirección elegida: desvío máximo entre esa dirección y "alejarlo" (cos 60°). */
const PUSH_ALIGN = 0.5;
const THROW_SPEED = 9;
const THROW_TIME = 0.8;
const THROW_CLIP = 'Spell_Simple_Shoot';
/** Al lanzar contra una unidad cae a su lado, a esta distancia de su borde (m). */
const THROW_GAP = 0.1;
/** Lados de la unidad apuntada donde probar a que caiga (rad, desde el lado del que viene). */
const THROW_SIDES = [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2, Math.PI];
/** Duración de lanzar una habilidad (la unidad está ocupada) y momento del efecto. */
const SKILL_TIME = 0.9;
const SKILL_DELAY = 0.45;
/** Altura sobre un punto del suelo a la que se comprueba la línea de visión (se ve la zona). */
const POINT_AIM_HEIGHT = 1;
const DASH_SPEED = 16;
const SHOVE_SPEED = 8;
/** Altura (sobre los pies) a la que se comprueba que el camino de una embestida está libre. */
const DASH_CLEARANCE = 1;
/** Empujar a mano (un objeto Grande): distancia (m). */
const HAND_PUSH_DISTANCE = 3;
/** Empuje y tirón de acero: velocidad con la que sale lo empujado o atraído (m/s). */
const STEEL_SPEED = 16;
/** Tirón: se para a esta distancia (de borde a borde) de quien tira. */
const PULL_GAP = 0.15;
/** Salto de acero: velocidad (más rápido que el salto normal). */
const LEAP_SPEED = 13;
/** Lanzar (peltre): daño base del impacto (una unidad o un objeto Grande) + FUE. */
const HURL_BASE = 10;
/** Peltre avivado: metros de movimiento extra por turno. */
const PEWTER_MOVEMENT = 3;
/** Deslizar: a esta distancia (de borde a borde) de la espalda de un enemigo, lo marca. */
const FLANK_REACH = 0.9;
/** Una unidad empujada contra una pared recibe +50 % (GDD §5). */
const WALL_MULTIPLIER = 1.5;
/** Plano de acción: segundos que se mantiene tras el impacto, y tras una muerte. */
const SHOT_AFTER_HIT = 0.7;
const SHOT_AFTER_KILL = 1.3;

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
 * objetos en línea recta (acción adicional) y lanzarlos en arco (acción), con daño de impacto
 * a quien pillen; barriles que explotan al destruirse (daño en área y
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
  /** El turno actual se pierde (empezó dentro de una burbuja de cadmio): pasa solo. */
  private turnLost = false;
  private turnTimer = 0;
  /** Segundos que lleva el turno de la IA (vigilante). */
  private aiTurnTime = 0;
  /** Turnos de la IA cortados por el vigilante (debería ser siempre 0). */
  private aiTimeouts = 0;
  private stateTimer = 0;
  private detectionTimer = 0;
  private listeners: ((event: string, data: EncounterEventData) => void)[] = [];
  /**
   * Acción (ataque, salto, empujón, habilidad) que espera a que la unidad termine de
   * acercarse. Al llegar se vuelve a pedir, ya sin acercarse: si algo ha cambiado, se cancela.
   */
  private pendingAction: { unit: UnitComponent; run: () => void } | null = null;
  private pendingHits: PendingHit[] = [];
  /** Habilidades lanzadas cuyo efecto aún no ha llegado (sincronizado con la animación). */
  private pendingSkills: { timer: number; caster: UnitComponent; plan: SkillPlan }[] = [];
  /** Objetos empujados o lanzados que aún no han llegado (el impacto es al llegar). */
  private pendingImpacts: PendingImpact[] = [];
  /**
   * Ataques y habilidades ya pagados que esperan a que la cámara de acción esté colocada
   * para empezar la animación (si no, el golpe llega mientras la cámara aún se mueve).
   */
  private windups: { timer: number; unit: UnitComponent; start: () => void }[] = [];
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
    Cover.newFrame();

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
    this.updateBubbles();
    SpiritZones.syncRelics();

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

  /**
   * ¿Le queda a `unit` un turno extra en esta ronda? (está dentro de una burbuja de bendaleo y
   * aún no lo ha jugado): la barra de iniciativa lo enseña dos veces seguidas.
   */
  public hasPendingExtraTurn(unit: UnitComponent): boolean {
    if (this.state !== 'combat' || !unit.isAlive()) return false;
    const bubble = Zones.containing(unit, 'fast');
    return !!bubble && bubble.extraTurns.get(unit) !== this.round;
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
      this.pendingAction !== null ||
      this.windups.length > 0 ||
      this.pendingHits.length > 0 ||
      this.pendingSkills.length > 0 ||
      this.pendingImpacts.length > 0
    );
  }

  public canRestart(): boolean {
    if (this.state === 'defeat') return true;
    return (
      this.state === 'exploration' &&
      !UnitComponent.getAll().some((u) => u.getFaction() === 'enemy' && u.isAlive())
    );
  }

  /**
   * Eventos: state:<estado>, turn, round, join, move, attack, damage, death, downed, revive,
   * restart, skill, status, status-end, impact, pushed, pulled, disarm, jump; metal (amount =
   * gastado), duralumin,
   * declare-drained y refill (la Reserva se llena al acabar el turno Seco); bubble,
   * slow-bubble, bubble-end, extra-turn y turn-lost (burbujas de bendaleo y cadmio);
   * spirit-zone, relic-burst y connected (un estado copiado por la Conexión: source = de quién).
   */
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

    let allowed = !this.isOccupied(unit) && unit.isAlive();
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
    // Dentro de una burbuja de bendaleo no se puede salir andando: se para en el borde.
    const bubble = this.state === 'combat' ? Zones.containing(unit) : null;
    const inside = bubble ? Zones.lengthInside(bubble, plan.points) : Infinity;
    if (inside < budget) budget = Math.max(0, inside);
    const affordable = plan.reachable && plan.length <= budget + EPS;
    // Destino demasiado lejos: se recorre el mismo camino hasta donde llegue el movimiento.
    const walk = affordable
      ? plan
      : plan.reachable && budget > EPS
        ? truncatePath(plan.points, budget)
        : empty;
    const canMove = allowed && walk.points.length >= 2;
    if (allowed && !plan.reachable) reason = 'destination not reachable';
    else if (allowed && !canMove) reason = inside < Infinity ? 'bubble' : 'no movement left';
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
  /**
   * Mueve la unidad si las reglas lo permiten. En exploración, si es el seleccionado, el resto
   * de la party le sigue (`follow` = false para moverlo solo).
   */
  public requestMove(entity: Entity, destination: vec3, follow = true): MovePlan & { ok: boolean } {
    // Asegura que la planificación ve los obstáculos actuales (y no el de la propia unidad).
    UnitObstacles.sync(this.getActingUnit());
    const move = this.planMove(entity, destination);
    const ok = move.canMove;
    if (ok) {
      if (this.state === 'combat') {
        this.resources.movement = Math.max(0, this.resources.movement - move.walk.length);
      }
      this.pendingAction = null;
      const unit = entity.getComponent('unit') as UnitComponent;
      void unit.moveAlong(move.walk.points);
      const party = PartyComponent.find();
      if (follow && this.state === 'exploration' && party?.getSelected() === entity) {
        party.followLeader(entity, move.walk.points);
      }
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
      minDamage: 0,
      maxDamage: 0,
      critDamage: 0,
      critChance: 0,
    };
    const fail = (reason: string): AttackPlan => ({ ...result, reason });
    if (!unit || !target) return fail('not a unit');
    if (!attack) return fail(`unknown attack '${attackId}'`);
    if (target === unit || target.getFaction() === unit.getFaction()) {
      return fail('cannot attack an ally');
    }
    if (!target.isAlive()) return fail('target is down');
    if (unit.hasStatus('fear')) return fail('frightened');

    result.distance = unitDistance(unit, target);
    result.inRange = result.distance <= attack.range + EPS;
    result.lineOfSight = attack.kind === 'melee' || unitLineOfSight(unit, target);
    const roll = previewAttack(unit, target, attack);
    result.hitChance = roll.hitChance;
    result.damage = roll.damage;
    result.minDamage = roll.minDamage;
    result.maxDamage = roll.maxDamage;
    result.critDamage = roll.critDamage;
    result.critChance = roll.critChance;

    const permission = this.canAct(unit, attack.cost ?? 'action');
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);

    if (result.inRange && result.lineOfSight) {
      result.canAttack = true;
      return result;
    }
    // No llega o no ve: buscar desde dónde sí (cuerpo a cuerpo, pegado; a distancia, a tiro).
    const melee = attack.kind === 'melee';
    const fractions = melee ? [APPROACH_FRACTION] : RANGED_RINGS;
    const radii = fractions.map(
      (k) => unit.getCapsuleRadius() + target.getCapsuleRadius() + attack.range * k,
    );
    result.approach = this.planApproachTo(
      entity,
      target.getFeetPosition(vec3.create()),
      radii,
      (feet) =>
        unitDistanceFrom(unit, feet, target) <= attack.range + EPS &&
        (melee || unitLineOfSightFrom(unit, feet, target)),
    );
    if (!result.approach) {
      if (melee) return fail('target out of reach');
      const feet = unit.getFeetPosition(vec3.create());
      if (Zones.blocksProjectile(feet, target.getFeetPosition(vec3.create()))) {
        return fail('bubble border');
      }
      if (Cover.isCovered(target, feet)) return fail('covered');
      return fail(result.inRange ? 'no line of sight' : 'target out of range');
    }
    result.canAttack = true;
    return result;
  }

  /**
   * Ataca si las reglas lo permiten. Fuera de alcance (o sin visión) se acerca primero (gasta
   * metros) y ataca al llegar. Fuera de combate, atacar a un enemigo empieza el combate.
   * `approach` = false: solo si ya llega (lo usa la acción pendiente al llegar).
   */
  public requestAttack(
    entity: Entity,
    targetEntity: Entity,
    attackId?: string | null,
    approach = true,
  ): AttackPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planAttack(entity, targetEntity, attackId);
    if (!plan.canAttack || !plan.attack) return { ...plan, ok: false };
    const unit = entity.getComponent('unit') as UnitComponent;
    const target = targetEntity.getComponent('unit') as UnitComponent;

    if (plan.approach) {
      const id = plan.attack.id;
      const moved =
        approach &&
        this.approachThen(entity, plan.approach, () =>
          this.requestAttack(entity, targetEntity, id, false),
        );
      return moved ? { ...plan, ok: true } : { ...plan, ok: false, reason: 'cannot approach' };
    }

    this.executeAttack(unit, target, plan.attack);
    return { ...plan, ok: true };
  }

  // ── Entorno: saltar y empujar (reglas compartidas por jugador, MCP e IA) ──

  /** ¿Puede `entity` saltar hasta `destination` (punto del suelo)? Cuesta los metros saltados. */
  public planJump(entity: Entity, destination: vec3): JumpPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const result: JumpPlan = {
      allowed: false,
      points: [],
      distance: 0,
      approach: null,
      canJump: false,
    };
    const fail = (reason: string): JumpPlan => ({ ...result, reason });
    if (!unit) return fail('not a unit');
    if (!unit.hasAbility('jump')) return fail('cannot jump');
    const permission = this.canAct(unit, null);
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    const budget = this.state === 'combat' ? this.resources.movement : Infinity;
    const maxJump = MAX_JUMP * (unit.hasStatus('iron_light') ? 2 : 1);
    if (this.leavesBubble(unit, destination)) return fail('bubble');
    const arc = jumpArc(unit.getFeetPosition(this.tmpA), destination, maxJump);
    if (!('reason' in arc) && arc.distance <= budget + EPS) {
      result.points = arc.points;
      result.distance = arc.distance;
      result.canJump = true;
      return result;
    }
    const reason = 'reason' in arc ? arc.reason : 'not enough movement';
    // Andar no arregla un aterrizaje imposible ni un salto demasiado corto.
    if (reason === 'cannot land there' || reason === 'too close') return fail(reason);

    // Andar hasta un punto de despegue desde el que llegue; andar + saltar cabe en los metros.
    // Primero al nivel en el que está (desde el suelo se salta desde el suelo junto al
    // saliente, no subiendo por la rampa para dar un saltito); si no hay, a cualquier nivel.
    const jumpFrom = (feet: vec3) => {
      const a = jumpArc(feet, destination, maxJump);
      return 'reason' in a ? null : a;
    };
    const level = unit.getFeetPosition(this.tmpA)[1]!;
    const findTakeoff = (sameLevel: boolean) =>
      this.planApproachTo(
        entity,
        destination,
        JUMP_RINGS.map((k) => maxJump * k),
        (feet) =>
          (!sameLevel || Math.abs(feet[1]! - level) < SAME_LEVEL) && jumpFrom(feet) !== null,
        (feet) => jumpFrom(feet)?.distance ?? Infinity,
      );
    result.approach = findTakeoff(true) ?? findTakeoff(false);
    if (!result.approach) return fail(reason);
    const walkEnd = result.approach.walk.points[result.approach.walk.points.length - 1]!;
    const from = jumpFrom(walkEnd);
    if (!from) return fail(reason);
    result.points = from.points;
    result.distance = from.distance;
    result.canJump = true;
    return result;
  }

  public requestJump(
    entity: Entity,
    destination: vec3,
    approach = true,
  ): JumpPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planJump(entity, destination);
    if (!plan.canJump) return { ...plan, ok: false };
    if (plan.approach) {
      const dest = vec3.clone(destination);
      const moved =
        approach &&
        this.approachThen(entity, plan.approach, () => this.requestJump(entity, dest, false));
      return moved ? { ...plan, ok: true } : { ...plan, ok: false, reason: 'cannot approach' };
    }
    if (this.state === 'combat') {
      this.resources.movement = Math.max(0, this.resources.movement - plan.distance);
    }
    this.pendingAction = null;
    const unit = entity.getComponent('unit') as UnitComponent;
    const last = plan.points[plan.points.length - 1]!;
    unit.faceTowards(vec3.fromValues(last[0]!, unit.getPosition(this.tmpA)[1]!, last[2]!));
    unit.playAction(JUMP_CLIP);
    void unit.moveAlong(plan.points, { speed: JUMP_SPEED, walk: false, face: false });
    this.emit('jump', { unit: entity });
    return { ...plan, ok: true };
  }

  /**
   * ¿Puede `entity` empujar el objeto `target`? Cuesta la acción adicional. Sin `direction`
   * lo aleja de sí; con ella (horizontal) se pone al otro lado para empujarlo hacia allí. Sale
   * en línea recta y se para contra lo primero que pille: si es una unidad, le hace daño de
   * impacto (y el objeto recibe lo mismo: un barril explota).
   */
  public planPush(entity: Entity, target: Entity, direction: vec3 | null = null): PushPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const prop = target.getComponent('unit') as UnitComponent | null;
    const result: PushPlan = {
      allowed: false,
      distance: Infinity,
      inReach: false,
      destination: null,
      pushLength: 0,
      direction: null,
      hit: null,
      minDamage: 0,
      maxDamage: 0,
      approach: null,
      canPush: false,
    };
    const fail = (reason: string): PushPlan => ({ ...result, reason });
    if (!unit || !prop) return fail('not a unit');
    if (!unit.hasAbility('push')) return fail('cannot push');
    const data = PropComponent.of(target);
    if (!data || data.isSmall() || !prop.isAlive()) return fail('not pushable');
    const impactDamage = data.getImpactBase() + unit.getAttribute('FUE');
    result.distance = unitDistance(unit, prop);
    result.inReach = result.distance <= PUSH_REACH + EPS;
    const permission = this.canAct(unit, 'bonusAction');
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    const wanted = direction ? horizontalDirection(direction) : null;

    // Cómo sale empujándolo desde `feet`: alejándolo, o hacia `wanted` si se empuja desde
    // el lado contrario.
    const center = prop.getFeetPosition(vec3.create());
    const awayFrom = (feet: vec3) =>
      horizontalDirection(vec3.fromValues(center[0]! - feet[0]!, 0, center[2]! - feet[2]!));
    const pushFrom = (feet: vec3) => {
      const away = awayFrom(feet);
      if (!away || (wanted && vec3.dot(away, wanted) < PUSH_ALIGN)) return null;
      const dir = wanted ?? away;
      const path = pushPath(prop, dir, HAND_PUSH_DISTANCE, unit);
      if (path.length < 0.3 && !path.hit) return null;
      const destination = vec3.scaleAndAdd(vec3.create(), center, dir, path.length);
      return { ...path, dir, destination };
    };
    const here = unit.getFeetPosition(vec3.create());
    let push = result.inReach ? pushFrom(here) : null;
    if (!push) {
      result.approach = this.planApproachTo(
        entity,
        center,
        [unit.getCapsuleRadius() + prop.getCapsuleRadius() + PUSH_REACH * APPROACH_FRACTION],
        (feet) => unitDistanceFrom(unit, feet, prop) <= PUSH_REACH + EPS && !!pushFrom(feet),
        // Con dirección: mejor justo detrás que de refilón.
        (feet) => (wanted ? (1 - vec3.dot(awayFrom(feet) ?? wanted, wanted)) * 2 : 0),
      );
      if (!result.approach) return fail(result.inReach ? 'push blocked' : 'too far to push');
      const points = result.approach.walk.points;
      push = pushFrom(points[points.length - 1]!);
      if (!push) return fail('push blocked');
    }
    result.pushLength = push.length;
    result.destination = push.destination;
    result.direction = push.dir;
    result.hit = push.hit;
    if (push.hit) {
      const range = hitRange(null, push.hit, impactDamage);
      result.minDamage = range.min;
      result.maxDamage = range.max;
    }
    result.canPush = true;
    return result;
  }

  public requestPush(
    entity: Entity,
    target: Entity,
    direction: vec3 | null = null,
    approach = true,
  ): PushPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planPush(entity, target, direction);
    if (!plan.canPush || !plan.destination) return { ...plan, ok: false };
    if (plan.approach) {
      const dir = direction ? vec3.clone(direction) : null;
      const moved =
        approach &&
        this.approachThen(entity, plan.approach, () =>
          this.requestPush(entity, target, dir, false),
        );
      return moved ? { ...plan, ok: true } : { ...plan, ok: false, reason: 'cannot approach' };
    }
    if (this.state === 'combat') {
      this.resources.bonusAction = Math.max(0, this.resources.bonusAction - 1);
    }
    this.pendingAction = null;
    const unit = entity.getComponent('unit') as UnitComponent;
    const prop = target.getComponent('unit') as UnitComponent;
    const data = PropComponent.of(target)!;
    unit.stop(); // exploración: puede venir andando
    unit.faceTowards(prop.getPosition(this.tmpA));
    const from = prop.getFeetPosition(vec3.create());
    const to = vec3.clone(plan.destination);
    const dir = vec3.clone(plan.direction!);
    // Plano de acción si golpea a alguien o si se estaba apuntando con la cámara.
    const camera = this.getActionCamera();
    const travel = slideTime(PUSH_SPEED, HAND_PUSH_DISTANCE, plan.pushLength);
    const shotTargets: (Entity | vec3)[] = [target, to];
    if (plan.hit) shotTargets.push(plan.hit.getOwner());
    const delay =
      plan.hit || camera?.isAiming()
        ? (camera?.frameAction(entity, shotTargets, PUSH_CONTACT + travel + SHOT_AFTER_HIT) ?? 0)
        : 0;
    // Se resuelve ya (no al acabar el plano): mientras, nadie puede actuar (isResolving).
    const impact: PendingImpact = {
      timer: Infinity,
      source: unit,
      body: prop,
      hit: plan.hit,
      damage: data.getImpactBase() + unit.getAttribute('FUE'),
      always: false,
      direction: dir,
      unitBody: false,
      wall: false,
    };
    this.pendingImpacts.push(impact);
    // Anticipación: la animación empieza y el objeto sale cuando las manos lo tocan.
    this.windUp(unit, delay, () => {
      unit.faceTowards(prop.getPosition(this.tmpA));
      unit.playAction(PUSH_CLIP, PUSH_TIME);
      this.windUp(unit, PUSH_CONTACT, () => {
        if (plan.pushLength > 0.05) {
          void prop.moveAlong([from, to], {
            speed: PUSH_SPEED,
            slide: HAND_PUSH_DISTANCE,
            spin: (Math.random() < 0.5 ? -1 : 1) * PUSH_SPIN * Math.min(1, plan.pushLength / 3),
            walk: false,
            face: false,
          });
        }
        impact.timer = 0.05;
      });
    });
    this.emit('push', { unit: target, source: entity });
    return { ...plan, ok: true };
  }

  /**
   * ¿Puede `entity` lanzar el objeto `target` a `aim` (una unidad o un punto)? Cuesta la
   * acción. Hay que estar al lado del objeto y el destino a THROW_RANGE como mucho de quien lo
   * lanza (si no, se acerca primero). Vuela en arco por encima de lo que haya en medio y golpea
   * a la unidad apuntada (cae a su lado) o a la primera que pille en el camino; al caer, el
   * objeto también recibe el impacto.
   */
  public planThrow(entity: Entity, target: Entity, aim: SkillTarget = {}): ThrowPlan {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    const prop = target.getComponent('unit') as UnitComponent | null;
    const result: ThrowPlan = {
      allowed: false,
      approach: null,
      points: [],
      landing: null,
      hit: null,
      minDamage: 0,
      maxDamage: 0,
      canThrow: false,
    };
    const fail = (reason: string): ThrowPlan => ({ ...result, reason });
    if (!unit || !prop) return fail('not a unit');
    if (!unit.hasAbility('throw')) return fail('cannot throw');
    const data = PropComponent.of(target);
    if (!data?.isSmall() || !prop.isAlive()) return fail('not throwable');
    const impactDamage = data.getImpactBase() + unit.getAttribute('FUE');
    const aimUnit = (aim.unit?.getComponent('unit') as UnitComponent | null) ?? null;
    if (aimUnit === prop || aimUnit === unit) return fail('no target');
    if (!aimUnit && !aim.point) return fail('no target');
    const permission = this.canAct(unit, 'action');
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);

    // Dónde cae: en el punto, o al lado de la unidad apuntada: del lado del que viene o, si ahí
    // no cabe (otra unidad, un objeto, un muro), del más cercano a ese que sí.
    const from = prop.getFeetPosition(vec3.create());
    let arc: ReturnType<typeof throwArc>;
    if (aimUnit) {
      const t = aimUnit.getFeetPosition(vec3.create());
      const back =
        horizontalDirection(vec3.fromValues(from[0]! - t[0]!, 0, from[2]! - t[2]!)) ??
        vec3.fromValues(1, 0, 0);
      const gap = aimUnit.getCapsuleRadius() + prop.getCapsuleRadius() + THROW_GAP;
      const base = Math.atan2(back[2]!, back[0]!);
      arc = { reason: 'cannot land there' };
      for (const offset of THROW_SIDES) {
        const angle = base + offset;
        const to = vec3.fromValues(
          t[0]! + Math.cos(angle) * gap,
          t[1]!,
          t[2]! + Math.sin(angle) * gap,
        );
        to[1] = groundHeightAt(to[0]!, to[2]!, t[1]! + 0.5) ?? t[1]!;
        const candidate = throwArc(from, to);
        if (!('reason' in candidate)) {
          arc = candidate;
          break;
        }
        // El motivo del lado preferido es el que se cuenta si no cabe en ninguno.
        if (offset === 0) arc = candidate;
      }
    } else {
      arc = throwArc(from, aim.point!);
    }
    if ('reason' in arc) return fail(arc.reason);
    const to = arc.points[arc.points.length - 1]!;
    const flight = flightHit(prop, arc.points, unit);
    result.points = flight.points;
    result.landing = flight.points[flight.points.length - 1]!;
    result.hit = flight.hit ?? aimUnit;
    const range = hitRange(null, result.hit ?? prop, impactDamage);
    result.minDamage = range.min;
    result.maxDamage = range.max;

    // Al lado del objeto y con el destino a tiro; si no, acercarse.
    const fits = (feet: vec3) =>
      unitDistanceFrom(unit, feet, prop) <= PUSH_REACH + EPS &&
      Math.hypot(to[0]! - feet[0]!, to[2]! - feet[2]!) <= THROW_RANGE + EPS;
    if (!fits(unit.getFeetPosition(vec3.create()))) {
      result.approach = this.planApproachTo(
        entity,
        from,
        [unit.getCapsuleRadius() + prop.getCapsuleRadius() + PUSH_REACH * APPROACH_FRACTION],
        fits,
      );
      if (!result.approach) {
        const near = unitDistance(unit, prop) <= PUSH_REACH + EPS;
        return fail(near ? 'too far to throw' : 'too far to pick up');
      }
    }
    result.canThrow = true;
    return result;
  }

  public requestThrow(
    entity: Entity,
    target: Entity,
    aim: SkillTarget = {},
    approach = true,
  ): ThrowPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planThrow(entity, target, aim);
    if (!plan.canThrow || !plan.landing) return { ...plan, ok: false };
    if (plan.approach) {
      const saved: SkillTarget = {
        unit: aim.unit ?? null,
        point: aim.point ? vec3.clone(aim.point) : null,
      };
      const moved =
        approach &&
        this.approachThen(entity, plan.approach, () =>
          this.requestThrow(entity, target, saved, false),
        );
      return moved ? { ...plan, ok: true } : { ...plan, ok: false, reason: 'cannot approach' };
    }
    if (this.state === 'combat') {
      this.resources.action = Math.max(0, this.resources.action - 1);
    }
    this.pendingAction = null;
    const unit = entity.getComponent('unit') as UnitComponent;
    const prop = target.getComponent('unit') as UnitComponent;
    const damage = PropComponent.of(target)!.getImpactBase() + unit.getAttribute('FUE');
    unit.stop(); // exploración: puede venir andando
    unit.faceTowards(plan.landing);
    // Plano de acción si golpea a alguien (como un ataque).
    const delay = plan.hit
      ? (this.getActionCamera()?.frameAction(
          unit.getOwner(),
          [plan.hit.getOwner(), prop.getOwner()],
          THROW_TIME + SHOT_AFTER_HIT,
        ) ?? 0)
      : 0;
    // Se resuelve ya (no al acabar el plano): mientras, nadie puede actuar (isResolving).
    this.pendingImpacts.push({
      timer: Infinity,
      source: unit,
      body: prop,
      hit: plan.hit,
      damage,
      always: true,
      direction: horizontalDirection(
        vec3.sub(vec3.create(), plan.landing, prop.getFeetPosition(vec3.create())),
      ),
      unitBody: false,
      wall: false,
    });
    const impact = this.pendingImpacts[this.pendingImpacts.length - 1]!;
    const points = plan.points.map((p) => vec3.clone(p));
    this.windUp(unit, delay, () => {
      unit.playAction(THROW_CLIP, THROW_TIME);
      void prop.moveAlong(points, { speed: THROW_SPEED, walk: false, face: false });
      impact.timer = 0.15;
    });
    this.emit('throw', { unit: target, source: entity });
    return { ...plan, ok: true };
  }

  /**
   * Algo empujado, atraído o lanzado ha llegado (GDD §5): golpea a quien pilla (que sale
   * despedido; un objeto Grande lo deja Aturdido, una unidad lo deja Derribado) y se golpea
   * él. Un objeto Pequeño se rompe siempre (se ha usado); uno Grande de los que se rompen al
   * chocar con alguien se rompe (y si cae al suelo lanzado, recibe el golpe); los que no ni se
   * dañan; una unidad llega
   * Derribada y, si ha chocado, recibe el golpe (+50 % contra una pared).
   */
  private applyImpact(impact: PendingImpact): void {
    const { hit, body } = impact;
    // Una tirada; cada uno la recibe con su armadura (el objeto, normalmente sin armadura).
    const u = Math.random();
    const amount = (unit: UnitComponent, multiplier = 1) =>
      rollRange(hitRange(null, unit, Math.round(impact.damage * multiplier)), u);
    const prop = PropComponent.of(body.getOwner());
    this.getActionCamera()?.shake(hit ? SHAKE_HIT : SHAKE_THUD);
    if (hit || impact.wall) {
      this.emit('impact', { unit: (hit ?? body).getOwner(), source: impact.source.getOwner() });
    }
    if (hit?.isAlive()) {
      this.applyHit(impact.source, hit, true, amount(hit), 'impact');
      if (hit.isAlive()) {
        if (impact.unitBody) this.applyStatus(hit, 'prone', impact.source);
        else if (prop && !prop.isSmall()) this.applyStatus(hit, 'stunned', impact.source);
        if (impact.direction) this.knockBack(hit, impact.direction);
      }
    }
    if (!body.isAlive()) return;
    if (impact.unitBody) {
      if (impact.wall && !hit) {
        this.applyHit(impact.source, body, true, amount(body, WALL_MULTIPLIER), 'impact');
      } else if (hit || impact.always) {
        // Choca con alguien o, lanzada (Lanzar), cae al suelo: también recibe el golpe.
        this.applyHit(impact.source, body, true, amount(body), 'impact');
      }
      if (body.isAlive()) this.applyStatus(body, 'prone', impact.source);
      return;
    }
    // Los Pequeños (cuchillos, clavos, monedas) se rompen siempre al usarlos, choquen o no.
    if (prop?.isSmall()) {
      this.onUnitDown(body, impact.source);
      return;
    }
    // Los que no se rompen al chocar (un carro) tampoco se dañan.
    if (!prop?.breaksOnImpact()) return;
    if (hit) this.onUnitDown(body, impact.source);
    else if (impact.always) this.applyHit(impact.source, body, true, amount(body), 'impact');
  }

  /** Empujón de un impacto: la unidad retrocede en `dir` (lo que deje el entorno). */
  private knockBack(unit: UnitComponent, dir: vec3): void {
    const length = pushDistance(unit, dir, KNOCKBACK);
    if (length < 0.1) return;
    const feet = unit.getFeetPosition(vec3.create());
    void unit.moveAlong([feet, vec3.scaleAndAdd(vec3.create(), feet, dir, length)], {
      speed: KNOCKBACK_SPEED,
      slide: KNOCKBACK * 1.2,
      walk: false,
      face: false,
    });
    this.emit('pushed', { unit: unit.getOwner(), source: null });
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
      reach: 0,
      closesBubble: false,
      motion: null,
      motions: [],
      connected: [],
      metalCost: 0,
      power: 1,
      approach: null,
      canCast: false,
    };
    const fail = (reason: string): SkillPlan => ({ ...result, canCast: false, reason });
    if (!unit) return fail('not a unit');
    if (!skill || !unit.hasSkill(skillId)) return fail(`unknown skill '${skillId}'`);
    // Con su burbuja activa, la habilidad la cierra (sin acción ni metal).
    if (isAnchoredBubble(skill) && Zones.ownedBy(unit)) {
      result.origin = unit.getFeetPosition(vec3.create());
      result.inRange = result.lineOfSight = true;
      result.affected = [unit];
      result.closesBubble = true;
      const permission = this.canAct(unit, null);
      result.allowed = permission === null;
      if (permission !== null) return fail(permission);
      result.canCast = true;
      return result;
    }
    const cost = metalCost(unit, skill);
    result.metalCost = this.state === 'combat' ? cost.metal : 0;
    // Investidura: lanzada desde dentro, +50 % (como el multiplicador del duraluminio).
    const power = cost.power * (isMetalAction(skill) ? 1 : SpiritZones.powerFor(unit));
    result.power = power;

    const feet = unit.getFeetPosition(vec3.create());
    const targetUnit = (target.unit?.getComponent('unit') as UnitComponent | null) ?? null;
    switch (skill.target) {
      case 'self': {
        result.origin = feet;
        result.inRange = result.lineOfSight = true;
        const bubble = skill.effects.find((e) => e.type === 'bubble');
        const radius = bubble ? this.bubbleRadius(unit, skill) : skill.radius;
        result.affected = radius > 0 ? unitsInCircle(skill, unit, feet, radius) : [unit];
        break;
      }
      case 'unit': {
        if (!targetUnit) return fail('no target');
        result.origin = targetUnit.getFeetPosition(vec3.create());
        const ally = targetUnit.getFaction() === unit.getFaction();
        if (skill.targets === 'ally' && !ally) return fail('target must be an ally');
        if (skill.targets === 'enemy' && ally) return fail('target must be an enemy');
        const revive = ally && hasEffect(skill, 'heal');
        if (!targetUnit.isAlive() && !revive) return fail('target is down');
        // Dardo de cromo: solo contra quien tiene Reserva (los alománticos).
        if (hasEffect(skill, 'drain') && !targetUnit.hasReserve()) {
          return fail('not allomantic');
        }
        const self = targetUnit === unit;
        const distance = unitDistance(unit, targetUnit);
        result.inRange =
          self || (distance <= skill.range + EPS && distance >= skill.minRange - EPS);
        result.lineOfSight = self || !skill.lineOfSight || unitLineOfSight(unit, targetUnit);
        result.affected =
          skill.radius > 0 ? unitsInCircle(skill, unit, result.origin, skill.radius) : [targetUnit];
        if (hasEffect(skill, 'hurl')) {
          const hurl = this.planHurl(unit, targetUnit, skill, target, power);
          if ('reason' in hurl) return fail(hurl.reason);
          result.motion = hurl.motion;
          if (hurl.motion?.hit) result.affected = [targetUnit, hurl.motion.hit];
        }
        if (hasEffect(skill, 'steelPush') || hasEffect(skill, 'ironPull')) {
          const motion = this.planMetalMotion(
            unit,
            targetUnit,
            skill,
            power,
            target.direction ?? null,
          );
          if ('reason' in motion) return fail(motion.reason);
          result.motion = motion;
        }
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
        // El borde de una burbuja de bendaleo desvía los proyectiles.
        result.lineOfSight =
          !skill.lineOfSight ||
          (hasLineOfSight(eye, aim) &&
            !Cover.propBlocks(eye, aim, [unit]) &&
            !Zones.blocksProjectile(feet, point));
        result.affected = skill.radius > 0 ? unitsInCircle(skill, unit, point, skill.radius) : [];
        // El tiempo de una burbuja (o una zona espiritual) no afecta a los objetos.
        if (hasEffect(skill, 'bubble') || hasEffect(skill, 'spiritZone')) {
          result.affected = result.affected.filter((u) => !PropComponent.of(u.getOwner()));
        }
        if (hasEffect(skill, 'radialPush')) {
          // Pulso de ettmetal: solo lo metálico se mueve (y lo que pille, recibe el golpe).
          result.motions = this.planRadialPush(unit, skill, point, power);
          const hit = result.motions.flatMap((m) => (m.hit ? [m.body, m.hit] : [m.body]));
          result.affected = [...new Set(hit)];
        }
        if (
          (hasEffect(skill, 'leap') || hasEffect(skill, 'teleport')) &&
          this.leavesBubble(unit, point)
        ) {
          return fail('bubble');
        }
        if (hasEffect(skill, 'leap')) {
          // Salto de acero: llega hasta donde dé el salto (no por el alcance de la habilidad).
          const arc = jumpArc(feet, point, this.leapDistance(unit, power));
          if ('reason' in arc) return fail(arc.reason);
          result.affected = [unit];
          result.inRange = result.lineOfSight = true;
          result.motion = {
            kind: 'leap',
            body: unit,
            points: arc.points,
            hit: null,
            wall: false,
            damage: 0,
          };
        }
        if (hasEffect(skill, 'teleport')) {
          result.affected = [unit];
          if (!isOnNavMesh(point[0]!, point[1]!, point[2]!, 0.3)) return fail('cannot land there');
          const a = vec3.fromValues(feet[0]!, feet[1]! + DASH_CLEARANCE, feet[2]!);
          const b = vec3.fromValues(point[0]!, point[1]! + DASH_CLEARANCE, point[2]!);
          if (!hasLineOfSight(a, b)) return fail('path blocked');
          // Deslizar: el enemigo a cuya espalda acaba queda Marcado.
          if (hasEffect(skill, 'flank')) {
            const flanked = flankedEnemy(unit, point);
            if (flanked) result.affected = [unit, flanked];
          }
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
      case 'line': {
        const point = target.point ?? targetUnit?.getFeetPosition(vec3.create()) ?? null;
        if (!point) return fail('no target');
        result.origin = feet;
        result.direction = coneDirection(feet, point);
        result.reach = Zones.borderDistance(
          feet,
          result.direction,
          lineReach(unit, result.direction, skill.length),
        );
        // Un prop alto (un carro) para la bala.
        const chest = vec3.fromValues(feet[0]!, feet[1]! + 1.3, feet[2]!);
        for (const p of Cover.tallProps()) {
          result.reach = Math.min(
            result.reach,
            rayToProp(chest, result.direction, p, result.reach),
          );
        }
        result.inRange = result.lineOfSight = true;
        result.affected = unitsInLine(skill, unit, point, result.reach);
        break;
      }
    }

    // Conexión: los estados se copian a los del mismo bando que estén en la zona.
    if (hasEffect(skill, 'status') || hasEffect(skill, 'drain')) {
      const copies = new Set<UnitComponent>();
      for (const u of result.affected) {
        for (const c of SpiritZones.connectedTo(u)) if (!result.affected.includes(c)) copies.add(c);
      }
      result.connected = [...copies];
    }

    if (unit.hasStatus('fear') && isHostile(skill)) return fail('frightened');
    const permission = this.canAct(unit, skill.cost === 'free' ? null : skill.cost, skill);
    result.allowed = permission === null;
    if (permission !== null) return fail(permission);
    if (this.state === 'combat' && unit.getCooldown(skill.id) > 0) return fail('on cooldown');
    if (!result.inRange || !result.lineOfSight) {
      // No llega o no ve: buscar desde dónde sí (unidad o punto; cono y self no se mueven).
      result.approach = this.planSkillApproach(entity, unit, skill, targetUnit, result.origin);
      if (!result.approach) {
        if (targetUnit && skill.target === 'unit' && Cover.isCovered(targetUnit, feet)) {
          return fail('covered');
        }
        return fail(result.inRange ? 'no line of sight' : 'target out of range');
      }
    }
    result.canCast = true;
    return result;
  }

  /**
   * Lanzar (peltre) `target` (pegado al lanzador: el alcance de la habilidad) en arco: al punto
   * elegido o junto a la unidad elegida (y la golpea), como mucho la distancia del efecto desde
   * donde está. Una unidad o un objeto Grande; los Pequeños y los inamovibles, no. Sin destino,
   * sin trayectoria (primer paso al apuntar).
   */
  private planHurl(
    caster: UnitComponent,
    target: UnitComponent,
    skill: SkillDef,
    aim: SkillTarget,
    power: number,
  ): { motion: SkillMotion | null } | { reason: string } {
    if (target === caster) return { reason: 'no target' };
    const prop = PropComponent.of(target.getOwner());
    if (prop?.isSmall()) return { reason: 'too small' };
    if (target.isImmovable()) return { reason: 'immovable' };
    const toUnit = (aim.toUnit?.getComponent('unit') as UnitComponent | null) ?? null;
    if (!toUnit && !aim.point) return { motion: null };
    if (toUnit === target || toUnit === caster) return { reason: 'no target' };
    const effect = skill.effects.find((e) => e.type === 'hurl');
    const distance = effect?.type === 'hurl' ? effect.distance : 10;
    const from = target.getFeetPosition(vec3.create());
    const arc = toUnit
      ? this.arcBeside(from, toUnit, target.getCapsuleRadius(), distance)
      : throwArc(from, aim.point!, distance);
    if ('reason' in arc)
      return { reason: arc.reason === 'too far to throw' ? 'too far' : arc.reason };
    const flight = flightHit(target, arc.points, caster);
    const damage = Math.round(
      (HURL_BASE + caster.getAttribute('FUE')) * damageDealtMultiplier(caster) * power,
    );
    return {
      motion: {
        kind: 'hurl',
        body: target,
        points: flight.points,
        hit: flight.hit ?? toUnit,
        wall: false,
        damage,
      },
    };
  }

  /** Arco de `from` a caer al lado de `unit` (por el lado del que viene o el más cercano libre). */
  private arcBeside(
    from: vec3,
    unit: UnitComponent,
    bodyRadius: number,
    maxFlight: number,
  ): ReturnType<typeof throwArc> {
    const t = unit.getFeetPosition(vec3.create());
    const back =
      horizontalDirection(vec3.fromValues(from[0]! - t[0]!, 0, from[2]! - t[2]!)) ??
      vec3.fromValues(1, 0, 0);
    const gap = unit.getCapsuleRadius() + bodyRadius + THROW_GAP;
    const base = Math.atan2(back[2]!, back[0]!);
    let arc: ReturnType<typeof throwArc> = { reason: 'cannot land there' };
    for (const offset of THROW_SIDES) {
      const angle = base + offset;
      const to = vec3.fromValues(
        t[0]! + Math.cos(angle) * gap,
        t[1]!,
        t[2]! + Math.sin(angle) * gap,
      );
      to[1] = groundHeightAt(to[0]!, to[2]!, t[1]! + 0.5) ?? t[1]!;
      const candidate = throwArc(from, to, maxFlight);
      if (!('reason' in candidate)) return candidate;
      if (offset === 0) arc = candidate;
    }
    return arc;
  }

  /**
   * Pulso de ettmetal: lo metálico dentro del área (menos el lanzador) sale en línea recta
   * alejándose del centro (si está justo en el centro, alejándose del lanzador).
   */
  private planRadialPush(
    caster: UnitComponent,
    skill: SkillDef,
    center: vec3,
    power: number,
  ): SkillMotion[] {
    const out: SkillMotion[] = [];
    for (const u of unitsInCircle(skill, caster, center, skill.radius)) {
      if (u === caster || !isMetallic(u) || u.isImmovable()) continue;
      const motion = this.planMetalMotion(caster, u, skill, power, null, center);
      if (!('reason' in motion)) out.push(motion);
    }
    return out;
  }

  /** Radio de una burbuja de bendaleo: el del efecto + lo que sume por POT. */
  private bubbleRadius(unit: UnitComponent, skill: SkillDef): number {
    const e = skill.effects.find((x) => x.type === 'bubble');
    if (e?.type !== 'bubble') return 0;
    return e.radius + (e.radiusPerPoint ?? 0) * unit.getAttribute('POT');
  }

  /**
   * Empuje o tirón de `caster` sobre `target` (GDD §5): solo lo metálico, en línea recta
   * (alejándose o hacia él), `3 + POT/2` m por el multiplicador; el tirón se para al llegar a su
   * lado. Lo que no es de metal pero lleva un arma de metal, con el tirón, se queda sin ella.
   * `from`: desde dónde se empuja (default: el lanzador; el pulso, desde su centro).
   */
  private planMetalMotion(
    caster: UnitComponent,
    target: UnitComponent,
    skill: SkillDef,
    power: number,
    wanted: vec3 | null = null,
    from: vec3 | null = null,
  ): SkillMotion | { reason: string } {
    if (target === caster) return { reason: 'no target' };
    const pull = hasEffect(skill, 'ironPull');
    if (!isMetallic(target)) {
      if (pull && target.hasMetalWeapon()) {
        return { kind: 'disarm', body: target, points: [], hit: null, wall: false, damage: 0 };
      }
      return { reason: 'not metallic' };
    }
    if (target.isImmovable()) return { reason: 'immovable' };
    const feet = target.getFeetPosition(vec3.create());
    const casterFeet = caster.getFeetPosition(vec3.create());
    const away =
      (from && horizontalDirection(vec3.sub(vec3.create(), feet, from))) ??
      horizontalDirection(vec3.sub(vec3.create(), feet, casterFeet)) ??
      caster.getFacing();
    const dir = pull ? vec3.negate(vec3.create(), away) : aimWithin(away, wanted, skill);
    let max = steelDistanceFor(caster.getAttributes()) * power;
    if (pull) max = Math.min(max, Math.max(0, unitDistance(caster, target) - PULL_GAP));
    const path = pushPath(target, dir, max, caster);
    const prop = PropComponent.of(target.getOwner());
    const base = prop ? prop.getImpactBase() : IMPACT_BASE.large;
    return {
      kind: pull ? 'pull' : 'push',
      body: target,
      points: [feet, vec3.scaleAndAdd(vec3.create(), feet, dir, path.length)],
      hit: path.hit,
      wall: path.blocked,
      damage: Math.round((base + caster.getAttribute('POT')) * power),
    };
  }

  /** Distancia del salto de acero: `6 + POT`, ×2 con la mente de hierro en Ligero. */
  private leapDistance(unit: UnitComponent, power: number): number {
    const light = unit.hasStatus('iron_light') ? 2 : 1;
    return steelJumpFor(unit.getAttributes()) * light * power;
  }

  /** Dónde ponerse para que una habilidad sobre una unidad o un punto llegue y vea. */
  private planSkillApproach(
    entity: Entity,
    unit: UnitComponent,
    skill: SkillDef,
    targetUnit: UnitComponent | null,
    origin: vec3 | null,
  ): MovePlan | null {
    if (skill.target === 'unit' && targetUnit && targetUnit !== unit) {
      return this.planApproachTo(
        entity,
        targetUnit.getFeetPosition(vec3.create()),
        RANGED_RINGS.map(
          (k) => unit.getCapsuleRadius() + targetUnit.getCapsuleRadius() + skill.range * k,
        ),
        (feet) =>
          unitDistanceFrom(unit, feet, targetUnit) <= skill.range + EPS &&
          unitDistanceFrom(unit, feet, targetUnit) >= skill.minRange - EPS &&
          (!skill.lineOfSight || unitLineOfSightFrom(unit, feet, targetUnit)),
      );
    }
    if (skill.target !== 'point' || !origin) return null;
    const point = origin;
    const dash = hasEffect(skill, 'teleport');
    return this.planApproachTo(
      entity,
      point,
      RANGED_RINGS.map((k) => skill.range * k),
      (feet) => {
        if (Math.hypot(point[0]! - feet[0]!, point[2]! - feet[2]!) > skill.range + EPS) {
          return false;
        }
        const eyeY = feet[1]! + unit.getFeetOffset() + EYE_HEIGHT;
        const eye = vec3.fromValues(feet[0]!, eyeY, feet[2]!);
        const aim = vec3.fromValues(point[0]!, point[1]! + POINT_AIM_HEIGHT, point[2]!);
        if (skill.lineOfSight && !hasLineOfSight(eye, aim)) return false;
        if (!dash) return true;
        const a = vec3.fromValues(feet[0]!, feet[1]! + DASH_CLEARANCE, feet[2]!);
        const b = vec3.fromValues(point[0]!, point[1]! + DASH_CLEARANCE, point[2]!);
        return hasLineOfSight(a, b);
      },
    );
  }

  /** Lanza la habilidad si las reglas lo permiten (gasta su recurso y empieza su cooldown). */
  public requestSkill(
    entity: Entity,
    skillId: string,
    target: SkillTarget = {},
    approach = true,
  ): SkillPlan & { ok: boolean } {
    UnitObstacles.sync(this.getActingUnit());
    const plan = this.planSkill(entity, skillId, target);
    if (!plan.canCast || !plan.skill || !plan.origin) return { ...plan, ok: false };
    if (plan.approach) {
      const saved: SkillTarget = {
        unit: target.unit ?? null,
        point: target.point ? vec3.clone(target.point) : null,
        direction: target.direction ? vec3.clone(target.direction) : null,
      };
      const moved =
        approach &&
        this.approachThen(entity, plan.approach, () =>
          this.requestSkill(entity, skillId, saved, false),
        );
      return moved ? { ...plan, ok: true } : { ...plan, ok: false, reason: 'cannot approach' };
    }
    const skill = plan.skill;
    const unit = entity.getComponent('unit') as UnitComponent;
    if (plan.closesBubble) {
      const bubble = Zones.ownedBy(unit);
      if (bubble) this.endBubble(bubble);
      return { ...plan, ok: true };
    }
    // Lanzar necesita destino (el segundo paso al apuntar).
    if (hasEffect(skill, 'hurl') && !plan.motion) {
      return { ...plan, ok: false, reason: 'no destination' };
    }
    if (this.state === 'combat') {
      if (skill.cost !== 'free') {
        this.resources[skill.cost] = Math.max(0, this.resources[skill.cost] - 1);
      }
      unit.setCooldown(skill.id, skill.cooldown);
      // Las del mismo grupo comparten la recarga.
      if (skill.group) {
        for (const id of unit.getSkillIds()) {
          if (SkillCatalog.get(id)?.group === skill.group) unit.setCooldown(id, skill.cooldown);
        }
      }
      if (plan.metalCost > 0) {
        unit.spendMetal(plan.metalCost);
        this.emit('metal', { unit: entity, amount: plan.metalCost });
      }
      // El duraluminio se gasta en esta (su multiplicador ya va en el plan).
      if (skill.allomantic) unit.setMetalBoost(null);
      if (skill.charge) unit.spendCharge(skill.charge);
    }
    this.pendingAction = null;
    unit.stop(); // exploración: puede venir andando
    this.emit('skill', { unit: entity });

    if (isMetalAction(skill)) {
      this.applyMetalAction(unit, skill);
      return { ...plan, ok: true };
    }

    if (plan.motion?.kind === 'leap') {
      // Salto de acero: en arco, sin gastar movimiento.
      const points = plan.motion.points.map((q) => vec3.clone(q));
      const last = points[points.length - 1]!;
      unit.faceTowards(vec3.fromValues(last[0]!, unit.getPosition(this.tmpA)[1]!, last[2]!));
      unit.playAction(JUMP_CLIP);
      void unit.moveAlong(points, { speed: LEAP_SPEED, walk: false, face: false });
      this.emit('jump', { unit: entity });
      return { ...plan, ok: true };
    }

    if (hasEffect(skill, 'teleport')) {
      // Embestida / Deslizar: en línea recta, muy rápido; no gasta movimiento.
      unit.faceTowards(plan.origin);
      const flanked = hasEffect(skill, 'flank')
        ? (plan.affected.find((u) => u !== unit) ?? null)
        : null;
      void unit
        .moveAlong([unit.getFeetPosition(), plan.origin], { speed: DASH_SPEED, walk: false })
        .then(() => {
          // A su espalda: queda Marcado.
          if (flanked?.isAlive()) this.applyStatus(flanked, 'marked', unit, 1);
        });
      return { ...plan, ok: true };
    }

    if ((skill.target === 'cone' || skill.target === 'line') && plan.direction) {
      const p = unit.getPosition(this.tmpA);
      unit.faceTowards(vec3.scaleAndAdd(this.tmpB, p, plan.direction, 1));
    } else if (skill.target !== 'self') {
      unit.faceTowards(plan.origin);
    }
    this.windUp(unit, this.frameSkill(unit, plan), () => {
      unit.playAction(skill.clip, SKILL_TIME);
      this.pendingSkills.push({ timer: SKILL_DELAY, caster: unit, plan });
    });
    return { ...plan, ok: true };
  }

  /** Plano de acción de una habilidad: el lanzador, los afectados y el centro del área. */
  private frameSkill(caster: UnitComponent, plan: SkillPlan): number {
    const targets: (Entity | vec3)[] = plan.affected
      .filter((u) => u !== caster)
      .map((u) => u.getOwner());
    if (plan.skill?.target === 'point' && plan.origin) targets.push(plan.origin);
    return (
      this.getActionCamera()?.frameAction(
        caster.getOwner(),
        targets,
        SKILL_DELAY + SHOT_AFTER_HIT,
      ) ?? 0
    );
  }

  /** Empieza la acción cuando la cámara esté colocada (`delay` s), o ya si no hay plano. */
  private windUp(unit: UnitComponent, delay: number, start: () => void): void {
    if (delay <= 0) start();
    else this.windups.push({ timer: delay, unit, start });
  }

  /**
   * Duraluminio o recargar: al momento, sin animación ni cámara de acción.
   * Eventos: duralumin (amount = ×; antes, metal con lo quemado) y declare-drained.
   */
  private applyMetalAction(unit: UnitComponent, skill: SkillDef): void {
    const entity = unit.getOwner();
    for (const effect of skill.effects) {
      switch (effect.type) {
        case 'duralumin': {
          const burnt = unit.burnAllMetal();
          const power = 1 + burnt / unit.getMaxMetal();
          unit.setMetalBoost({ power });
          this.emit('metal', { unit: entity, amount: burnt });
          this.emit('duralumin', { unit: entity, amount: power });
          break;
        }
        case 'refill':
          unit.setDrainPending(true);
          this.emit('declare-drained', { unit: entity });
          break;
        default:
          break;
      }
    }
  }

  /**
   * Fin del turno de `unit` (después de descontar sus estados): el duraluminio sin usar se
   * pierde y, si ha vaciado la Reserva o se ha declarado Seco, queda Seca su turno
   * siguiente (al acabarlo expira el estado y la Reserva se llena: endTurn).
   */
  private settleMetal(unit: UnitComponent): void {
    unit.setMetalBoost(null);
    const empty = unit.getMetal() <= 0 || unit.isDrainPending();
    unit.setDrainPending(false);
    if (!unit.hasReserve() || !unit.isAlive() || unit.isDrained() || !empty) return;
    unit.addStatus('drained', 1, unit.getOwner());
    this.emit('status', { unit: unit.getOwner(), source: unit.getOwner(), status: 'drained' });
  }

  /** Efectos de una habilidad al llegar el momento del impacto. */
  private applySkill(caster: UnitComponent, plan: SkillPlan): void {
    const skill = plan.skill!;
    const origin = plan.origin!;
    const affected = () => plan.affected.filter((u) => u.isAlive() || hasEffect(skill, 'heal'));
    // El daño (todos los efectos de daño + escala) se aplica una vez, con una sola tirada:
    // la misma fracción del rango para todos, cada uno con su armadura. No critica.
    const damage = skillDamage(caster, skill, plan.power);
    const penetration = Math.max(
      0,
      ...skill.effects.map((e) => (e.type === 'damage' ? (e.penetration ?? 0) : 0)),
    );
    let damageDone = false;
    for (const effect of skill.effects) {
      switch (effect.type) {
        case 'damage': {
          if (damageDone) break;
          damageDone = true;
          const roll = Math.random();
          for (const u of affected()) {
            if (!u.isAlive()) continue;
            // Un proyectil (línea) contra la Burbuja de acero: 50 % de fallar.
            const bubble = skill.target === 'line' && u.hasStatus('steel_bubble');
            if (bubble && Math.random() < STEEL_BUBBLE_MISS) {
              this.applyHit(caster, u, false, 0, 'skill');
              continue;
            }
            const range = hitRange(caster, u, damage, penetration);
            this.applyHit(caster, u, true, rollRange(range, roll), 'skill');
          }
          break;
        }
        case 'heal': {
          // Inyector de oro: 12 + POT.
          const base = effect.amount + (skill.scale ? caster.getAttribute(skill.scale) : 0);
          for (const u of affected()) this.healUnit(u, Math.round(base * plan.power));
          break;
        }
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
            const length = pushDistance(u, dir, effect.distance * plan.power);
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
        case 'status': {
          // La magnitud escala con el atributo de la habilidad (Marca del cazador: 30 % + 5 %·POT).
          const scale = skill.scale ? caster.getAttribute(skill.scale) : 0;
          const options: StatusOptions = {};
          if (effect.amount !== undefined) {
            options.amount = effect.amount + (effect.amountPerPoint ?? 0) * scale;
          }
          if (effect.untilTurnStart) options.untilTurnStart = true;
          for (const u of affected())
            this.applyStatus(u, effect.status, caster, effect.turns, options);
          break;
        }
        case 'steelPush':
        case 'ironPull':
          if (plan.motion) this.launch(caster, plan.motion);
          break;
        case 'hurl':
          if (plan.motion) this.launchArc(caster, plan.motion);
          break;
        case 'finisher':
          for (const u of affected()) {
            if (!u.isAlive()) continue;
            const { damage: d, points } = finisherDamage(caster, u);
            caster.removeStatus('rhythm');
            this.emit('status-end', { unit: caster.getOwner(), status: 'rhythm' });
            this.applyHit(caster, u, true, rollRange(hitRange(caster, u, d)), 'skill');
            if (points >= RHYTHM_MAX && u.isAlive()) this.applyStatus(u, 'stunned', caster);
          }
          break;
        case 'bubble': {
          // Centrada en el lanzador (anclada) o lanzada al punto (una granada).
          const anchored = skill.target === 'self';
          const center = anchored ? caster.getFeetPosition(vec3.create()) : vec3.clone(origin);
          const radius = this.bubbleRadius(caster, skill);
          const time = effect.time ?? 'fast';
          Zones.add(caster, center, radius, this.round + effect.rounds, time, anchored);
          this.emit(time === 'slow' ? 'slow-bubble' : 'bubble', {
            unit: caster.getOwner(),
            amount: radius,
          });
          break;
        }
        case 'drain':
          // Dardo de cromo: Seco su turno siguiente (applyStatus le vacía la Reserva).
          for (const u of affected()) {
            if (u.isAlive() && u.hasReserve()) this.applyStatus(u, 'drained', caster, 1);
          }
          break;
        case 'spiritZone': {
          // Una a la vez: la nueva sustituye a la anterior.
          SpiritZones.clear((z) => z.caster === caster);
          SpiritZones.add(effect.zone, origin, effect.radius, {
            caster,
            untilRound: this.round + effect.rounds,
          });
          this.emit('spirit-zone', { unit: caster.getOwner() });
          break;
        }
        case 'radialPush':
          for (const m of plan.motions) this.launch(caster, m);
          break;
        case 'teleport':
        case 'leap':
        case 'flank':
        case 'duralumin':
        case 'refill':
          break; // se resuelven al lanzar
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

  /**
   * Empuje o tirón ya resuelto: lo que se mueve sale disparado por su trayectoria y, al
   * llegar, el impacto (applyImpact). Un desarme no mueve nada: el objetivo se queda sin arma.
   */
  private launch(caster: UnitComponent, motion: SkillMotion): void {
    const body = motion.body;
    if (!body.isAlive()) return;
    if (motion.kind === 'disarm') {
      body.disarm();
      this.emit('disarm', { unit: body.getOwner(), source: caster.getOwner() });
      return;
    }
    const [from, to] = [motion.points[0]!, motion.points[motion.points.length - 1]!];
    const length = vec3.distance(from, to);
    body.stop();
    if (length > 0.05) {
      void body.moveAlong([vec3.clone(from), vec3.clone(to)], {
        speed: STEEL_SPEED,
        slide: length,
        walk: false,
        face: false,
      });
    }
    this.pendingImpacts.push({
      timer: 0.05,
      source: caster,
      body,
      hit: motion.hit,
      damage: motion.damage,
      always: false,
      direction: horizontalDirection(vec3.sub(vec3.create(), to, from)),
      unitBody: !PropComponent.of(body.getOwner()),
      wall: motion.wall,
    });
    this.emit(motion.kind === 'pull' ? 'pulled' : 'pushed', {
      unit: body.getOwner(),
      source: caster.getOwner(),
    });
  }

  /**
   * Lanzar (peltre): lo que se lanza vuela en arco y, al caer, IMPACTO: golpea a quien pille y
   * se golpea él al caer (una unidad, además, queda Derribada).
   */
  private launchArc(caster: UnitComponent, motion: SkillMotion): void {
    const body = motion.body;
    if (!body.isAlive()) return;
    const points = motion.points.map((q) => vec3.clone(q));
    const from = points[0]!;
    const to = points[points.length - 1]!;
    body.stop();
    void body.moveAlong(points, { speed: THROW_SPEED, walk: false, face: false });
    this.pendingImpacts.push({
      timer: 0.15,
      source: caster,
      body,
      hit: motion.hit,
      damage: motion.damage,
      always: true,
      direction: horizontalDirection(vec3.sub(vec3.create(), to, from)),
      unitBody: !PropComponent.of(body.getOwner()),
      wall: false,
    });
    this.emit('thrown', { unit: body.getOwner(), source: caster.getOwner() });
  }

  /**
   * Aplica un estado (evento status). Derribado y Aturdido duran hasta que empiece su turno;
   * la mente de hierro en Pesado hace inmune a Derribado. Los objetos no tienen estados.
   */
  private applyStatus(
    unit: UnitComponent,
    id: UnitStatusId,
    source: UnitComponent | null,
    turns = 1,
    options: StatusOptions = {},
    spread = true,
  ): boolean {
    // Los objetos (cajas, barriles) no tienen estados.
    if (!unit.isAlive() || PropComponent.of(unit.getOwner())) return false;
    // Conexión: se copia a los de su bando que estén en la misma zona (las copias, no otra vez).
    const connected = spread ? SpiritZones.connectedTo(unit) : [];
    if (id === 'prone' && unit.hasStatus('iron_heavy')) return false;
    // Peltre avivado: inmune a Derribado y Aturdido.
    if ((id === 'prone' || id === 'stunned') && unit.hasStatus('pewter')) return false;
    // Aturdido: se pierde el Ritmo.
    if (id === 'stunned' && unit.hasStatus('rhythm')) {
      unit.removeStatus('rhythm');
      this.emit('status-end', { unit: unit.getOwner(), status: 'rhythm' });
    }
    const untilTurnStart = options.untilTurnStart ?? (id === 'stunned' || id === 'prone');
    unit.addStatus(id, turns, source?.getOwner() ?? null, { ...options, untilTurnStart });
    if (source !== unit) unit.stop();
    // Peltre avivado en su turno: los metros extra ya.
    if (id === 'pewter' && unit.getOwner() === this.getActiveUnit()) {
      this.resources.movement += PEWTER_MOVEMENT;
    }
    // Mente de oro: la primera curación, al decantar.
    if (id === 'gold_heal' && options.amount) this.healUnit(unit, options.amount);
    // Seco por otro (dardo de cromo): la Reserva, vacía (al acabar el turno Seco, se llena).
    if (id === 'drained') {
      unit.burnAllMetal();
      unit.setMetalBoost(null);
      unit.setDrainPending(false);
    }
    this.emit('status', { unit: unit.getOwner(), source: source?.getOwner() ?? null, status: id });
    for (const c of connected) {
      if (this.applyStatus(c, id, source, turns, options, false)) {
        this.emit('connected', { unit: c.getOwner(), source: unit.getOwner(), status: id });
      }
    }
    return true;
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
    // La bolsa de crítico y la Reserva de metal se llenan al empezar el combate.
    for (const c of this.combatants) {
      c.unit.resetCritChance();
      c.unit.refillMetal();
      c.unit.resetForCombat();
    }

    for (const c of this.combatants) c.unit.stop();
    this.pendingAction = null;
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
    if (
      active?.unit.isBusy() ||
      this.pendingAction ||
      this.windups.length ||
      this.pendingHits.length
    )
      return false;
    if (active) {
      const unit = active.unit;
      for (const status of unit.tickStatuses()) {
        this.emit('status-end', { unit: unit.getOwner(), status });
        // Se acaba el turno Seco: se ha bebido el vial.
        if (status === 'drained') {
          unit.refillMetal();
          this.emit('refill', { unit: unit.getOwner(), amount: unit.getMetal() });
        }
        // Se acaba el peltre avivado: Arrastre durante su siguiente turno.
        if (status === 'pewter' && unit.isAlive()) {
          unit.addStatus('pewter_drag', 1, unit.getOwner());
          this.emit('status', {
            unit: unit.getOwner(),
            source: unit.getOwner(),
            status: 'pewter_drag',
          });
        }
      }
      // Un turno sin golpear: se pierde el Ritmo.
      if (unit.hasStatus('rhythm') && !unit.hasHitThisTurn()) {
        unit.removeStatus('rhythm');
        this.emit('status-end', { unit: unit.getOwner(), status: 'rhythm' });
      }
      this.settleMetal(unit);
      // Burbuja de bendaleo: quien acaba su turno dentro juega otro seguido (uno por ronda).
      const bubble = unit.isAlive() && !this.turnLost ? Zones.containing(unit, 'fast') : null;
      if (bubble && bubble.extraTurns.get(unit) !== this.round) {
        bubble.extraTurns.set(unit, this.round);
        this.emit('extra-turn', { unit: unit.getOwner() });
        this.beginTurn();
        return true;
      }
    }
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
    this.pendingAction = null;
    this.round = 0;
    this.turnIndex = 0;
    this.turnLost = false;
    Zones.clear();
    SpiritZones.clear((z) => !z.relic);
    for (const u of UnitComponent.getAll()) {
      u.clearCooldowns();
      u.clearStatuses();
      u.refillMetal();
      u.resetForCombat();
      u.resetCritChance();
      this.getAI(u)?.clearPlan();
    }
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
    this.pendingAction = null;
    this.pendingHits = [];
    this.pendingSkills = [];
    this.windups = [];
    this.disengaged.clear();
    this.round = 0;
    this.turnIndex = 0;
    this.turnLost = false;
    for (const unit of UnitComponent.getAll()) {
      unit.resetToSpawn();
      this.getAI(unit)?.clearPlan();
    }
    this.surfaces.reset();
    Zones.clear();
    SpiritZones.clear((z) => !z.relic);
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
  /**
   * ¿Está ocupada para empezar otra cosa? Atacando, saltando o esperando a la cámara de acción.
   * Andar solo la ocupa en combate: en exploración un nuevo click corta el movimiento.
   */
  private isOccupied(unit: UnitComponent): boolean {
    if (this.windups.some((w) => w.unit === unit)) return true;
    if (this.state === 'exploration' && unit.isWalking()) return false;
    return unit.isBusy();
  }

  /** `skill`: además, que pueda pagar su metal (metalBlocker). */
  private canAct(
    unit: UnitComponent,
    cost: 'action' | 'bonusAction' | null,
    skill: SkillDef | null = null,
  ): string | null {
    if (!unit.isAlive()) return 'unit is down';
    if (this.isOccupied(unit) || (this.pendingAction && this.state === 'combat')) {
      return 'unit is busy';
    }
    const entity = unit.getOwner();
    if (this.state === 'combat') {
      if (entity !== this.getActiveUnit()) return 'not this unit’s turn';
      if (this.turnLost) return 'turn lost';
      if (cost && this.resources[cost] <= 0)
        return cost === 'action' ? 'no action left' : 'no bonus action left';
      return skill ? this.metalBlocker(unit, skill) : null;
    }
    if (this.state === 'exploration') {
      if (entity !== PartyComponent.find()?.getSelected()) {
        return 'only the selected party member acts in exploration';
      }
      return skill ? this.metalBlocker(unit, skill) : null;
    }
    return `cannot act during ${this.state}`;
  }

  /**
   * ¿Qué impide pagar la habilidad? (null: nada). Sin cargas de su mente de metal, Seco, no llega el metal o,
   * para las acciones de metal, que ahora no tengan sentido. Fuera de
   * combate la alomancia no gasta metal y las acciones de metal no se usan. La hotbar lo usa
   * para desactivar lo que no se puede pagar.
   */
  public metalBlocker(unit: UnitComponent, skill: SkillDef): string | null {
    // Cerrar la burbuja propia no cuesta nada.
    if (isAnchoredBubble(skill) && Zones.ownedBy(unit)) return null;
    // Mente de metal: una carga por combate, que no se recarga.
    if (skill.charge && this.state === 'combat' && unit.getCharges(skill.charge) <= 0) {
      return 'no charges';
    }
    if (isMetalAction(skill)) {
      if (this.state !== 'combat') return 'only in combat';
      if (unit.isDrained()) return 'drained';
      if (hasEffect(skill, 'refill')) {
        if (unit.isDrainPending()) return 'already drained';
        if (unit.getMetal() <= 0) return 'no metal';
        return unit.getMetal() >= unit.getMaxMetal() ? 'reserve full' : null;
      }
      if (unit.getMetalBoost()) return 'already boosted';
      return unit.getMetal() <= 0 ? 'no metal' : null;
    }
    if (!skill.allomantic) return null;
    if (unit.isDrained()) return 'drained';
    if (this.state === 'combat' && unit.getMetal() < metalCost(unit, skill).metal) {
      return 'not enough metal';
    }
    return null;
  }

  /** Mejor punto (camino más corto, dentro del presupuesto) desde el que atacar cuerpo a cuerpo. */
  /**
   * Dónde ponerse para hacer algo que desde aquí no llega (atacar, saltar, empujar, una
   * habilidad). Candidatos en anillos de `radii` metros alrededor de `center`; vale el que
   * cumpla `fits` (las reglas de la acción desde ese sitio) y cuyo camino, más `extraCost`
   * (p.ej. los metros del salto), quepa en el movimiento que queda. El más corto.
   */
  private planApproachTo(
    entity: Entity,
    center: vec3,
    radii: number[],
    fits: (feet: vec3) => boolean,
    extraCost: (feet: vec3) => number = () => 0,
  ): MovePlan | null {
    const unit = entity.getComponent('unit') as UnitComponent | null;
    if (!unit) return null;
    const from = unit.getFeetPosition(vec3.create());
    const budget = this.state === 'combat' ? this.resources.movement : Infinity;
    const candidates: { point: vec3; straight: number }[] = [];
    for (const radius of radii) {
      for (let i = 0; i < APPROACH_CANDIDATES; i++) {
        const angle = (i / APPROACH_CANDIDATES) * Math.PI * 2;
        const x = center[0]! + Math.cos(angle) * radius;
        const z = center[2]! + Math.sin(angle) * radius;
        const y = groundHeightAt(x, z, center[1]! + 1.5) ?? center[1]!;
        const straight = Math.hypot(x - from[0]!, z - from[2]!);
        if (straight > budget + EPS) continue; // ningún camino es más corto que la recta
        candidates.push({ point: vec3.fromValues(x, y, z), straight });
      }
    }
    candidates.sort((p, q) => p.straight - q.straight);

    let best: MovePlan | null = null;
    let bestCost = Infinity;
    for (const c of candidates) {
      if (c.straight >= bestCost) break;
      // Las reglas primero (rayos, barato); el camino solo si desde ahí se podría.
      if (!fits(c.point)) continue;
      const move = this.planMove(entity, c.point);
      if (!move.canMove || !move.affordable) continue;
      // Donde acaba el camino de verdad (el navmesh puede dejarlo unos cm más adentro).
      const end = move.walk.points[move.walk.points.length - 1]!;
      if (!fits(end)) continue;
      const cost = move.plan.length + extraCost(end);
      if (cost > budget + EPS || cost >= bestCost) continue;
      best = move;
      bestCost = cost;
    }
    return best;
  }

  /** Anda hasta el final de `approach` y, al llegar, `then` (vuelve a pedir la acción). */
  private approachThen(entity: Entity, approach: MovePlan, then: () => void): boolean {
    const points = approach.walk.points;
    const move = this.requestMove(entity, points[points.length - 1]!);
    if (!move.ok) return false;
    this.pendingAction = { unit: entity.getComponent('unit') as UnitComponent, run: then };
    return true;
  }

  private executeAttack(unit: UnitComponent, target: UnitComponent, attack: UnitAttack): void {
    unit.stop(); // exploración: puede venir andando
    if (this.state === 'combat') {
      const cost = attack.cost ?? 'action';
      this.resources[cost] = Math.max(0, this.resources[cost] - 1);
    }
    unit.faceTowards(target.getPosition(this.tmpA));
    const delay =
      this.getActionCamera()?.frameAction(
        unit.getOwner(),
        [target.getOwner()],
        HIT_DELAY + SHOT_AFTER_HIT,
      ) ?? 0;
    this.windUp(unit, delay, () => {
      unit.faceTowards(target.getPosition(this.tmpA));
      unit.playAction(attack.clip, ATTACK_TIME);
      const roll = rollAttack(unit, target, attack);
      this.pendingHits.push({ timer: HIT_DELAY, attacker: unit, target, ...roll });
      this.emit('attack', { unit: target.getOwner(), source: unit.getOwner() });
    });
  }

  /** Acciones en curso: la que espera a terminar de acercarse y los impactos pendientes. */
  private updateAttacks(dt: number): void {
    const pending = this.pendingAction;
    if (pending && !pending.unit.isMoving()) {
      this.pendingAction = null;
      pending.run();
    }

    if (this.windups.length) {
      const ready = this.windups.filter((w) => (w.timer -= dt) <= 0);
      this.windups = this.windups.filter((w) => w.timer > 0);
      for (const w of ready) w.start();
    }

    if (this.pendingImpacts.length) {
      // Al llegar: el objeto ya no se mueve (y ha pasado un instante, por si no se ha movido).
      const landed = (i: PendingImpact) => (i.timer -= dt) <= 0 && !i.body.isMoving();
      const ready = this.pendingImpacts.filter(landed);
      this.pendingImpacts = this.pendingImpacts.filter((i) => !ready.includes(i));
      for (const i of ready) this.applyImpact(i);
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
    for (const h of due) this.applyHit(h.attacker, h.target, h.hit, h.damage, 'attack', h.crit);
  }

  private applyHit(
    attacker: UnitComponent | null,
    target: UnitComponent,
    hit: boolean,
    damage: number,
    cause: DamageCause,
    crit = false,
  ): void {
    if (!target.isAlive()) return;
    const health = target.getHealth();
    const before = health?.getHp() ?? 0;
    if (hit && health) health.takeDamage(damage, attacker?.getOwner() ?? null);
    const dealt = before - (health?.getHp() ?? 0);
    // Ritmo: un golpe con el arma suma un punto (o empieza de nuevo si cambia de objetivo).
    if (attacker?.hasRhythm() && cause === 'attack' && hit && target.isAlive()) {
      const points = attacker.addRhythm(target);
      this.emit('rhythm', { unit: attacker.getOwner(), amount: points });
    }
    // El Marcado se consume con el siguiente golpe (su +% ya iba en hitRange).
    if (hit && dealt > 0 && cause !== 'fire' && cause !== 'debug' && target.hasStatus('marked')) {
      target.removeStatus('marked');
      this.emit('status-end', { unit: target.getOwner(), status: 'marked' });
    }
    this.emit('damage', {
      unit: target.getOwner(),
      source: attacker?.getOwner() ?? null,
      amount: dealt,
      hit,
      crit: hit && crit,
      cause,
    });

    if (health && health.getHp() <= 0) {
      // Ver caer al objetivo antes de volver a la cámara de juego.
      if (attacker) this.getActionCamera()?.holdShot(SHOT_AFTER_KILL);
      this.onUnitDown(target, attacker);
    } else if (hit) target.playAction(HIT_CLIP);

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
      // Un relicario roto suelta su zona de golpe, donde estaba, hasta la ronda siguiente.
      const relic = prop.getRelic();
      if (relic && this.state === 'combat') {
        SpiritZones.add(relic.zone, unit.getFeetPosition(vec3.create()), relic.radius, {
          untilRound: this.round + 1,
        });
        this.emit('relic-burst', { unit: unit.getOwner() });
      }
      const explosion = prop.getExplosion();
      if (explosion) this.explode(unit, explosion, instigator);
      else this.surfaces.spawnEffect(DEBRIS_PREFAB, unit.getFeetPosition(), DEBRIS_LIFETIME, 0.4);
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
        const range = hitRange(null, u, explosion.damage);
        this.applyHit(instigator, u, true, rollRange(range), 'explosion');
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
        this.pendingAction = null;
        this.windups = [];
        this.pendingHits = [];
        this.pendingImpacts = [];
        this.endTurn();
        return;
      }
    }

    if (active.unit.isBusy() || this.isResolving()) return;

    // Turno perdido (cadmio): se ve un momento y pasa.
    if (this.turnLost) {
      this.turnTimer -= dt;
      if (this.turnTimer <= 0) this.endTurn();
      return;
    }

    if (this.isPlayerTurn()) {
      const input = Engine.getInput();
      if (input.isKeyJustPressed(KeyCode.SPACE) && !CharacterSheetController.isOpen()) {
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
    // (Las acciones de metal no cuentan: sin nada más que hacer, no se espera por ellas.)
    const selfSkill = unit.getSkillIds().some((id) => {
      const skill = SkillCatalog.get(id);
      return (
        skill?.target === 'self' &&
        !isMetalAction(skill) &&
        skill.cost !== 'free' &&
        this.resources[skill.cost] > 0 &&
        unit.getCooldown(id) === 0 &&
        this.metalBlocker(unit, skill) === null
      );
    });
    if (selfSkill) return true;
    return (
      this.resources.bonusAction > 0 &&
      unit.hasAbility('push') &&
      UnitComponent.getAll().some((u) => this.planPush(unit.getOwner(), u.getOwner()).canPush)
    );
  }

  /** ¿Saldría `unit` de la burbuja en la que está yendo a `destination`? (solo en combate) */
  private leavesBubble(unit: UnitComponent, destination: vec3): boolean {
    const bubble = this.state === 'combat' ? Zones.containing(unit) : null;
    return !!bubble && !Zones.contains(bubble, destination);
  }

  /** Una burbuja anclada se rompe si quien la creó sale de ella (o cae). */
  private updateBubbles(): void {
    for (const b of [...Zones.getAll()]) {
      if (!b.anchored) continue;
      const feet = b.caster.getFeetPosition(this.tmpA);
      if (!b.caster.isAlive() || !Zones.contains(b, feet)) this.endBubble(b);
    }
  }

  private endBubble(bubble: TimeBubble): void {
    Zones.remove(bubble);
    this.emit('bubble-end', { unit: bubble.caster.getOwner() });
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
      // Las lanzadas caducan en el turno de quien las lanzó (beginTurn); aquí, por si ha caído.
      for (const b of [...Zones.getAll()]) {
        if (this.round >= b.untilRound + (b.anchored ? 0 : 1)) this.endBubble(b);
      }
      // Las de un relicario roto, al empezar la ronda; las liberadas, en el turno de quien las
      // liberó (beginTurn) o aquí, una ronda después, si ha caído.
      SpiritZones.clear((z) => this.round >= z.untilRound + (z.caster ? 1 : 0));
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
    // Una burbuja lanzada dura rondas completas: caduca al empezar el turno de quien la lanzó.
    for (const b of [...Zones.getAll()]) {
      if (!b.anchored && b.caster === active.unit && this.round >= b.untilRound) {
        this.endBubble(b);
      }
    }
    SpiritZones.clear((z) => z.caster === active.unit && this.round >= z.untilRound);
    // Burbuja de cadmio: quien empieza su turno dentro lo pierde (una vez por burbuja).
    const slow = Zones.containing(active.unit, 'slow');
    this.turnLost = !!slow && !slow.lostTurns.has(active.unit);
    if (this.turnLost) {
      slow!.lostTurns.add(active.unit);
      this.resources = { action: 0, bonusAction: 0, movement: 0 };
    }
    // Peltre avivado: +3 m. Arrastre: la mitad. Aturdido: pierde la Acción. Derribado:
    // levantarse cuesta la mitad del movimiento.
    if (active.unit.hasStatus('pewter')) this.resources.movement += PEWTER_MOVEMENT;
    if (active.unit.hasStatus('pewter_drag')) this.resources.movement /= 2;
    if (active.unit.hasStatus('stunned')) this.resources.action = 0;
    if (active.unit.hasStatus('prone')) this.resources.movement /= 2;
    active.unit.setHitThisTurn(false);
    // Mente de oro: se cura al empezar cada turno mientras dure.
    const gold = active.unit.getStatus('gold_heal');
    if (gold?.amount) this.healUnit(active.unit, gold.amount);
    for (const status of active.unit.clearTurnStartStatuses()) {
      this.emit('status-end', { unit: active.unit.getOwner(), status });
    }
    this.turnTimer = this.enemyTurnDelay;
    this.aiTurnTime = 0;
    active.unit.tickCooldowns();
    if (!this.turnLost) this.getAI(active.unit)?.beginTurn(this);

    const entity = active.unit.getOwner();
    const party = PartyComponent.find();
    if (party?.isMember(entity)) {
      party.select(entity, 'code'); // la cámara lo sigue
    } else {
      this.getCamera()?.focusOn(entity, true);
    }
    this.emit('turn', { unit: entity });
    if (this.turnLost) this.emit('turn-lost', { unit: entity });
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
    unit.refillMetal();
    unit.resetForCombat();
    // Si entra antes (o en) la posición actual, la unidad activa no cambia: juega la ronda siguiente.
    if (index <= this.turnIndex) this.turnIndex++;
    this.emit('join', { unit: unit.getOwner() });
  }

  /** Iniciativa individual: 2·REF + 1d4 (GDD §3). */
  private rollInitiative(unit: UnitComponent): Combatant {
    return { unit, initiative: rollInitiative(unit.getAttributes()), tiebreak: Math.random() };
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

  private getActionCamera(): ActionCameraComponent | null {
    return ActionCameraComponent.find();
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
        bubbles: Zones.getAll().map((b) => ({
          caster: b.caster.getOwner().getName(),
          center: Array.from(b.center).map((v) => Math.round(v * 100) / 100),
          radius: Math.round(b.radius * 100) / 100,
          time: b.time,
          anchored: b.anchored,
          untilRound: b.untilRound,
        })),
        spiritZones: SpiritZones.getAll().map((z) => ({
          kind: z.kind,
          center: Array.from(z.center).map((v) => Math.round(v * 100) / 100),
          radius: z.radius,
          caster: z.caster?.getOwner().getName() ?? null,
          relic: z.relic?.getOwner().getName() ?? null,
          untilRound: Number.isFinite(z.untilRound) ? z.untilRound : null,
        })),
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
            bonus: this.getAI(p.unit)?.getLastBonus()?.reason ?? null,
          })),
        units: UnitComponent.getAll().map((u) => ({
          name: u.getOwner().getName(),
          faction: u.getFaction(),
          hp: u.getHp(),
          maxHp: u.getMaxHp(),
          alive: u.isAlive(),
          attributes: u.hasAttributes() ? { ...u.getAttributes() } : null,
          armor: u.getArmor(),
          critChance: u.getCritChance(),
          nextCritChance: u.getNextCritChance(),
          metal: u.getMetal(),
          maxMetal: u.getMaxMetal(),
          metalBoost: u.getMetalBoost(),
          drainPending: u.isDrainPending(),
          statuses: u.getStatuses().map((st) => ({
            id: st.id,
            turns: Number.isFinite(st.turns) ? st.turns : null,
            source: st.source?.getName() ?? null,
            ...(st.amount !== undefined && { amount: st.amount }),
          })),
          metallic: u.isMetallic(),
          disarmed: u.isDisarmed(),
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
          minDamage: r.minDamage,
          maxDamage: r.maxDamage,
          critDamage: r.critDamage,
          critChance: r.critChance,
          reason: r.reason ?? null,
        });
        switch (name) {
          case 'move': {
            const to = args.to as [number, number, number] | undefined;
            if (!Array.isArray(to)) throw new Error('move needs args.to = [x, y, z]');
            const result = this.requestMove(
              unitArg(),
              vec3.fromValues(to[0], to[1], to[2]),
              args.follow !== false,
            );
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
          case 'roll_attack': {
            // Tira un ataque sin aplicarlo (saca canica de la bolsa): para probar el rango.
            const unit = unitArg().getComponent('unit') as UnitComponent;
            const target = unitArg('target').getComponent('unit') as UnitComponent;
            const attack = unit.getAttack(args.attack as string | undefined);
            if (!attack) throw new Error(`Unknown attack: ${String(args.attack)}`);
            return rollAttack(unit, target, attack);
          }
          case 'roll_initiative': {
            // Tira la iniciativa de esas unidades y las ordena como al empezar un combate.
            const names = (args.units as string[] | undefined) ?? [];
            const order = names
              .map((n) => {
                const unit = Engine.getEntities().getEntityByName(n)?.getComponent('unit');
                if (!unit) throw new Error(`Unit not found: ${n}`);
                return this.rollInitiative(unit as UnitComponent);
              })
              .sort(compareInitiative);
            return order.map((c) => ({
              name: c.unit.getOwner().getName(),
              ref: c.unit.getAttribute('REF'),
              initiative: c.initiative,
            }));
          }
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
              approach: r.approach ? r.approach.plan.length : null,
              reason: r.reason ?? null,
            };
          }
          case 'push':
          case 'plan_push': {
            // args.direction = [x, z] (opcional): hacia dónde empujarlo.
            const d = args.direction as [number, number] | undefined;
            const dir = Array.isArray(d) ? vec3.fromValues(d[0], 0, d[1]) : null;
            const r =
              name === 'push'
                ? this.requestPush(unitArg(), unitArg('target'), dir)
                : { ...this.planPush(unitArg(), unitArg('target'), dir), ok: null };
            return {
              ok: r.ok,
              canPush: r.canPush,
              allowed: r.allowed,
              inReach: r.inReach,
              distance: r.distance,
              pushLength: r.pushLength,
              destination: r.destination ? Array.from(r.destination) : null,
              hit: r.hit?.getOwner().getName() ?? null,
              minDamage: r.minDamage,
              maxDamage: r.maxDamage,
              approach: r.approach ? r.approach.plan.length : null,
              reason: r.reason ?? null,
            };
          }
          case 'throw':
          case 'plan_throw': {
            // args.object: el objeto; args.target (unidad) o args.to = [x, y, z] (punto).
            const to = args.to as [number, number, number] | undefined;
            const aim: SkillTarget = {
              unit: typeof args.target === 'string' ? unitArg('target') : null,
              point: Array.isArray(to) ? vec3.fromValues(to[0], to[1], to[2]) : null,
            };
            const r =
              name === 'throw'
                ? this.requestThrow(unitArg(), unitArg('object'), aim)
                : { ...this.planThrow(unitArg(), unitArg('object'), aim), ok: null };
            return {
              ok: r.ok,
              canThrow: r.canThrow,
              allowed: r.allowed,
              landing: r.landing ? Array.from(r.landing) : null,
              apex: r.points.length ? Math.max(...r.points.map((q) => q[1]!)) : null,
              hit: r.hit?.getOwner().getName() ?? null,
              minDamage: r.minDamage,
              maxDamage: r.maxDamage,
              approach: r.approach ? r.approach.plan.length : null,
              reason: r.reason ?? null,
            };
          }
          case 'skill':
          case 'plan_skill': {
            const skillId = String(args.skill ?? '');
            const to = args.to as [number, number, number] | undefined;
            // args.direction = [x, z] (opcional): hacia dónde empujar.
            const d = args.direction as [number, number] | undefined;
            const target: SkillTarget = {
              unit: typeof args.target === 'string' ? unitArg('target') : null,
              point: Array.isArray(to) ? vec3.fromValues(to[0], to[1], to[2]) : null,
              direction: Array.isArray(d) ? vec3.fromValues(d[0], 0, d[1]) : null,
              toUnit: typeof args.toUnit === 'string' ? unitArg('toUnit') : null,
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
              metalCost: r.metalCost,
              power: r.power,
              reach: r.reach,
              motion: r.motion ? motionSummary(r.motion) : null,
              motions: r.motions.map(motionSummary),
              connected: r.connected.map((u) => u.getOwner().getName()),
              approach: r.approach ? r.approach.plan.length : null,
              reason: r.reason ?? null,
            };
          }
          case 'cover': {
            // args.to = [x, y, z]: el snap de la unidad ahí, sus caras y de quién está a cubierto.
            const to = args.to as [number, number, number];
            const unit = unitArg().getComponent('unit') as UnitComponent;
            const snapped = Cover.snap(
              vec3.fromValues(to[0], to[1], to[2]),
              unit.getCapsuleRadius(),
              unit,
            );
            const faces = Cover.faces(snapped, unit.getCapsuleRadius(), unit);
            const round = (v: number) => Math.round(v * 100) / 100;
            return {
              snapped: Array.from(snapped).map(round),
              faces: faces.map((f) => [round(f.dir[0]!), round(f.dir[2]!)]),
              hiddenFrom: UnitComponent.getAll()
                .filter((u) => u.isAlive() && u.getFaction() === 'enemy')
                .filter((u) =>
                  Cover.coveredAt(snapped, unit.getCapsuleRadius(), u.getFeetPosition(), unit),
                )
                .map((u) => u.getOwner().getName()),
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
              `Unknown command '${name}'. Available: move, plan_move, attack, plan_attack, jump, plan_jump, push, plan_push, throw, plan_throw, skill, plan_skill, damage, end_turn, start_combat, end_combat, restart, select`,
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
/** `v` en horizontal y normalizado (null si no tiene componente horizontal). */
/**
 * Segundos que tarda en recorrer `length` m algo que sale a `speed` y frena para pararse a
 * `slide` m (UnitComponent.moveAlong con `slide`).
 */
function slideTime(speed: number, slide: number, length: number): number {
  if (length <= 0) return 0;
  const decel = (speed * speed) / (2 * Math.max(slide, length));
  const end = Math.sqrt(Math.max(0, speed * speed - 2 * decel * length));
  return (speed - end) / decel;
}

/** Un movimiento de habilidad para el MCP (plan_skill / skill). */
function motionSummary(m: SkillMotion) {
  return {
    kind: m.kind,
    body: m.body.getOwner().getName(),
    to: m.points.length
      ? Array.from(m.points[m.points.length - 1]!).map((v) => Math.round(v * 100) / 100)
      : null,
    hit: m.hit?.getOwner().getName() ?? null,
    wall: m.wall,
    damage: m.damage,
  };
}

function horizontalDirection(v: vec3): vec3 | null {
  const length = Math.hypot(v[0]!, v[2]!);
  return length < 1e-4 ? null : vec3.fromValues(v[0]! / length, 0, v[2]! / length);
}

/** Mayor iniciativa primero; a igualdad, más REF; si no, al azar. */
function compareInitiative(a: Combatant, b: Combatant): number {
  return (
    b.initiative - a.initiative ||
    b.unit.getAttribute('REF') - a.unit.getAttribute('REF') ||
    b.tiebreak - a.tiebreak
  );
}

/**
 * Dirección del empuje: `away` (alejándolo del lanzador) girada hacia `wanted` como mucho la
 * mitad del ángulo de apuntado de la habilidad. Sin `wanted`, `away`.
 */
function aimWithin(away: vec3, wanted: vec3 | null, skill: SkillDef): vec3 {
  const want = wanted ? horizontalDirection(wanted) : null;
  if (!want) return away;
  const effect = skill.effects.find((e) => e.type === 'steelPush');
  const half = (((effect?.type === 'steelPush' && effect.aimAngle) || 40) * Math.PI) / 360;
  const cross = away[0]! * want[2]! - away[2]! * want[0]!;
  const dot = away[0]! * want[0]! + away[2]! * want[2]!;
  const angle = Math.max(-half, Math.min(half, Math.atan2(cross, dot)));
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return vec3.fromValues(away[0]! * c - away[2]! * sn, 0, away[0]! * sn + away[2]! * c);
}

/**
 * El enemigo a cuya espalda acabaría `unit` con los pies en `point`: pegado a él (de borde a
 * borde, FLANK_REACH) y detrás de hacia donde mira.
 */
function flankedEnemy(unit: UnitComponent, point: vec3): UnitComponent | null {
  const p = vec3.create();
  for (const u of UnitComponent.getAll()) {
    if (!u.isAlive() || u.getFaction() === unit.getFaction() || u.getFaction() === 'neutral') {
      continue;
    }
    u.getFeetPosition(p);
    const dx = point[0]! - p[0]!;
    const dz = point[2]! - p[2]!;
    const dist = Math.hypot(dx, dz);
    if (dist - u.getCapsuleRadius() - unit.getCapsuleRadius() > FLANK_REACH || dist < 1e-3) {
      continue;
    }
    const facing = u.getFacing();
    if ((dx * facing[0]! + dz * facing[2]!) / dist < -0.3) return u;
  }
  return null;
}
