import { quat, vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import { HealthComponent } from '../HealthComponent';
import { RenderComponent } from '../../render/RenderComponent';
import type { SkeletalMeshComponent } from '../../render/SkeletalMeshComponent';
import { groundHeightAt } from './TacticalQueries';
import {
  critChanceFor,
  initiativeBaseFor,
  makeAttributes,
  maxHpFor,
  movementFor,
  penetrationFor,
  statusBonusTurnsFor,
  type AttributeId,
  type Attributes,
} from './Stats';

export type UnitFaction = 'party' | 'enemy' | 'neutral';

/** Un ataque de la unidad (arma). Daño = arma + atributo de escala (FUE). */
export interface UnitAttack {
  /** Identificador ('melee', 'ranged'…). */
  id: string;
  /** Nombre visible (hotbar, tooltips). */
  name: string;
  /** Cuerpo a cuerpo (se puede acercar y atacar) o a distancia (requiere línea de visión). */
  kind: 'melee' | 'ranged';
  /** Alcance en metros, de borde a borde de las cápsulas. */
  range: number;
  /** Daño del arma; se le suma el atributo de escala. Sin dados (GDD §4). */
  damage: number;
  /** Atributo con el que escala el daño. Default 'FUE' (melee y a distancia). */
  scale?: AttributeId;
  /** Recurso que consume. Default 'action'. */
  cost?: 'action' | 'bonusAction';
  /** Animación (clip) al atacar. */
  clip?: string;
}

const DEFAULT_ATTACKS: UnitAttack[] = [
  {
    id: 'melee',
    name: 'Golpe',
    kind: 'melee',
    range: 1.5,
    damage: 10,
    clip: 'Sword_Attack_Standing',
  },
];

export type UnitComponentDataType = Readonly<{
  /** Bando de la unidad. Default: 'neutral'. */
  faction?: UnitFaction;
  /** Nombre visible (UI). Default: nombre de la entidad. */
  displayName?: string;
  /** Oficio que enseña la ficha del personaje (Guerrero, Clérigo…). */
  role?: string;
  /**
   * Atributos (FUE, RES, POT, TEM, REF, AGU; los que falten valen 0). Con atributos, la vida,
   * el movimiento y el crítico salen de ellos (Stats.ts) salvo que se den aquí a mano. Sin
   * atributos (objetos) se usan los valores del prefab.
   */
  attributes?: Partial<Record<AttributeId, number>>;
  /** Armadura (de momento del prefab; vendrá del equipo). Default 0. */
  armor?: number;
  /** Nivel (vida +5 por nivel). Default 1. */
  level?: number;
  /** Velocidad al andar (m/s). Default 4. */
  moveSpeed?: number;
  /** Metros de movimiento por turno. Default: 6 + REF/2 con atributos; 9 sin ellos. */
  movement?: number;
  /** Distancia a la que detecta a unidades enemigas (m). 0 = no detecta. Default: 8 enemigos, 0 resto. */
  sightRange?: number;
  /** Ataques (orden de la hotbar; el primero es el de por defecto). Default: un golpe cuerpo a cuerpo. */
  attacks?: UnitAttack[];
  /** Acciones de la hotbar además de los ataques: saltar, empujar objetos. Default: ninguna. */
  abilities?: UnitAbility[];
  /** Al caer desaparece (objetos destruidos, p.ej. un barril que explota). Default false. */
  hideWhenDown?: boolean;
  /** Silueta (verde aliado, roja enemigo) en las partes que tape la escena. Default true. */
  silhouette?: boolean;
  /** Habilidades (ids de data/skills.json), en el orden de la hotbar. Default: ninguna. */
  skills?: string[];
  /** % de crítico de los ataques. Default: 5 % · (1 + ⌊AGU/2⌋) con atributos; 0 sin ellos. */
  critChance?: number;
}>;

/** Estado alterado (miedo…). Dura `turns` turnos de la unidad afectada. */
export type UnitStatusId = 'fear';

export interface UnitStatus {
  id: UnitStatusId;
  /** Turnos de la unidad que le quedan (se descuenta al acabar cada uno de sus turnos). */
  turns: number;
  /** Quién lo causó (p.ej. de quién huye una unidad asustada). */
  source: Entity | null;
}

/** Acciones que no son ataques: saltar (gasta movimiento) y empujar un objeto (acción adicional). */
export type UnitAbility = 'jump' | 'push' | 'throw';

export interface MoveOptions {
  /** Velocidad (m/s). Default: la de la unidad. */
  speed?: number;
  /** Animación de andar. Default true (false: saltos, objetos empujados). */
  walk?: boolean;
  /** Girarse hacia donde avanza. Default true. */
  face?: boolean;
  /**
   * Deslizar frenando (objetos empujados): sale a `speed` y frena como si fuera a pararse a
   * `slide` m. Si el camino es más corto (choca con algo), llega aún rápido. Default 0 (no frena).
   */
  slide?: number;
  /** Giro (rad, sobre la vertical) que da mientras recorre el camino. Default 0. */
  spin?: number;
}

/** Deslizar: velocidad mínima al final, para que acabe de llegar (m/s). */
const SLIDE_MIN_SPEED = 0.8;

const UP = vec3.fromValues(0, 1, 0);

/**
 * UnitComponent — unidad del juego táctico (miembro de la party, enemigo o neutral).
 *
 * Sabe moverse a lo largo de un camino (cuerpo kinematic + orientación + animación de
 * andar), dónde tiene los pies, qué ataques tiene y cómo se ve al atacar, recibir un golpe
 * o caer. La vida es su HealthComponent. Las reglas (quién puede moverse o atacar, cuánto)
 * las pone EncounterComponent; aquí solo está la ejecución.
 */
export class UnitComponent extends Component {
  private faction: UnitFaction = 'neutral';
  private displayName: string | null = null;
  private role: string | null = null;
  private moveSpeed = 4;
  private movement = 9;
  private sightRange = 0;
  private attacks: UnitAttack[] = DEFAULT_ATTACKS;
  private down = false;
  private abilities: UnitAbility[] = [];
  private hideWhenDown = false;
  private skills: string[] = [];
  /** Turnos que le quedan a cada habilidad para volver a estar disponible. */
  private cooldowns = new Map<string, number>();
  private statuses = new Map<UnitStatusId, UnitStatus>();
  private critChance = 0;
  /** Atributos (null: objeto sin atributos; las fórmulas los toman como 0). */
  private attributes: Attributes | null = null;
  private armor = 0;
  private level = 1;
  /** Derivados, para get_entity del MCP (los usa el código a través de los getters). */
  private stats: UnitStats | null = null;
  /** Vida máxima de los atributos aún por aplicar al HealthComponent (se hace en el 1er update). */
  private pendingMaxHp: number | null = null;
  private silhouette = true;
  /** Material de silueta aplicado ahora (undefined = aún no se ha decidido). */
  private silhouetteShown: string | null | undefined = undefined;
  /** Bolsa de canicas del crítico: las que quedan y cuántas de ellas son crítico. */
  private bagMarbles = 0;
  private bagCrits = 0;
  private pathSpeed = 4;
  private pathTurns = true;
  /** El movimiento en curso es andar (no un salto, empujón o embestida): se puede cortar. */
  private pathWalk = true;
  /** Deslizar: frenada (m/s²; 0 = velocidad constante). */
  private pathDecel = 0;
  private pathTravelled = 0;
  private pathLength = 0;
  private pathSpin = 0;
  private readonly spinStart = quat.create();
  /** Segundos que le quedan a la acción en curso (animación de ataque). */
  private actionTimer = 0;
  /** Dónde empezó (para reiniciar el encuentro). */
  private spawn: { position: vec3; rotation: quat } | null = null;

  /** Distancia vertical del centro de la cápsula (pivote) a los pies. */
  private feetOffset: number | null = null;
  private path: vec3[] = [];
  private pathIndex = 0;
  private onArrive: (() => void) | null = null;
  /** Posición de pies durante un movimiento (no depende del retardo del cuerpo kinematic). */
  private readonly movingFeet = vec3.create();

  private readonly tmp = vec3.create();
  private readonly tmpDir = vec3.create();
  private readonly tmpRot = quat.create();

  public load(data: UnitComponentDataType): void {
    this.faction = data.faction ?? 'neutral';
    this.displayName = data.displayName ?? null;
    this.role = data.role ?? null;
    this.moveSpeed = data.moveSpeed ?? this.moveSpeed;
    this.movement = data.movement ?? this.movement;
    this.sightRange = data.sightRange ?? (this.faction === 'enemy' ? 8 : 0);
    this.attacks = data.attacks ? data.attacks.map((a) => ({ ...a })) : DEFAULT_ATTACKS;
    this.abilities = [...(data.abilities ?? [])];
    this.hideWhenDown = data.hideWhenDown ?? false;
    this.skills = [...(data.skills ?? [])];
    this.attributes = data.attributes ? makeAttributes(data.attributes) : null;
    this.armor = data.armor ?? 0;
    this.level = data.level ?? 1;
    const a = this.attributes;
    this.movement = data.movement ?? (a ? movementFor(a) : this.movement);
    this.critChance = data.critChance ?? (a ? critChanceFor(a) : 0);
    this.pendingMaxHp = a ? maxHpFor(a, this.level) : null;
    this.silhouette = data.silhouette ?? true;
    this.stats = a ? this.computeStats() : null;
  }

  public update(dt: number): void {
    if (this.feetOffset === null) this.computeFeetOffset();
    if (!this.spawn) this.saveSpawn();
    if (this.pendingMaxHp !== null) this.applyMaxHp();
    if (this.actionTimer > 0) this.actionTimer = Math.max(0, this.actionTimer - dt);
    this.updateSilhouette();

    if (this.path.length === 0) return;

    this.advanceAlongPath(dt);
  }

  // ── Consultas ────────────────────────────────────────────────────────────

  public getFaction(): UnitFaction {
    return this.faction;
  }

  public getDisplayName(): string {
    return this.displayName ?? this.getOwner().getName();
  }

  public getRole(): string | null {
    return this.role;
  }

  /** Hacia dónde mira (horizontal, normalizado). */
  public getFacing(out: vec3 = vec3.create()): vec3 {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    const rot = transform?.getTransform().getLocalRotation();
    vec3.set(out, 0, 0, 1);
    if (rot) vec3.transformQuat(out, out, rot);
    out[1] = 0;
    return vec3.length(out) > 1e-4 ? vec3.normalize(out, out) : vec3.set(out, 0, 0, 1);
  }

  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  /** Metros de movimiento por turno. */
  public getMovement(): number {
    return this.movement;
  }

  public getSightRange(): number {
    return this.sightRange;
  }

  public isMoving(): boolean {
    return this.path.length > 0;
  }

  /** Andando (no saltando, empujado ni embistiendo): en exploración un nuevo destino lo corta. */
  public isWalking(): boolean {
    return this.isMoving() && this.pathWalk && this.actionTimer <= 0;
  }

  /** Moviéndose o en mitad de una acción (animación de ataque). */
  public isBusy(): boolean {
    return this.isMoving() || this.actionTimer > 0;
  }

  public getAbilities(): readonly UnitAbility[] {
    return this.abilities;
  }

  public hasAbility(ability: UnitAbility): boolean {
    return this.abilities.includes(ability);
  }

  public getSkillIds(): readonly string[] {
    return this.skills;
  }

  public hasSkill(id: string): boolean {
    return this.skills.includes(id);
  }

  /** Turnos que faltan para poder usar la habilidad (0 = disponible). */
  public getCooldown(id: string): number {
    return this.cooldowns.get(id) ?? 0;
  }

  public setCooldown(id: string, turns: number): void {
    if (turns > 0) this.cooldowns.set(id, turns);
    else this.cooldowns.delete(id);
  }

  /** Empieza un turno de la unidad: los cooldowns avanzan uno. */
  public tickCooldowns(): void {
    for (const [id, turns] of this.cooldowns) this.setCooldown(id, turns - 1);
  }

  public clearCooldowns(): void {
    this.cooldowns.clear();
  }

  // ── Atributos ────────────────────────────────────────────────────────────

  /** ¿Tiene atributos? (los objetos no: sus valores salen del prefab). */
  public hasAttributes(): boolean {
    return this.attributes !== null;
  }

  /** Atributos (todos a 0 si no tiene). */
  public getAttributes(): Readonly<Attributes> {
    return this.attributes ?? NO_ATTRIBUTES;
  }

  public getAttribute(id: AttributeId): number {
    return this.getAttributes()[id];
  }

  public getArmor(): number {
    return this.armor;
  }

  /** Para pruebas y, más adelante, el equipo. */
  public setArmor(armor: number): void {
    this.armor = Math.max(0, armor);
    if (this.stats) this.stats = this.computeStats();
  }

  public getLevel(): number {
    return this.level;
  }

  /** Penetración de armadura = ⌊AGU/2⌋. */
  public getPenetration(): number {
    return penetrationFor(this.getAttributes());
  }

  /** Turnos extra de los estados que aplica (POT 4 y POT 8). */
  public getStatusBonusTurns(): number {
    return statusBonusTurnsFor(this.getAttributes());
  }

  /** Parte fija de la iniciativa (2·REF; al empezar el combate se suma 1d4). */
  public getInitiativeBase(): number {
    return initiativeBaseFor(this.getAttributes());
  }

  /** Daño base (D, antes de armadura) de un ataque: arma + atributo de escala. */
  public getAttackDamage(attack: UnitAttack): number {
    return attack.damage + this.getAttribute(attack.scale ?? 'FUE');
  }

  /** Atributos y derivados (null sin atributos). */
  public getStats(): Readonly<UnitStats> | null {
    return this.stats;
  }

  private computeStats(): UnitStats {
    const a = this.getAttributes();
    return {
      maxHp: this.pendingMaxHp ?? this.getMaxHp(),
      movement: this.movement,
      critChance: this.critChance,
      penetration: penetrationFor(a),
      initiative: initiativeBaseFor(a),
      statusBonusTurns: statusBonusTurnsFor(a),
      armor: this.armor,
    };
  }

  /** La vida máxima sale de RES: se aplica al HealthComponent (que ya ha cargado su prefab). */
  private applyMaxHp(): void {
    const health = this.getHealth();
    if (!health) return;
    health.setMaxHp(this.pendingMaxHp!);
    this.pendingMaxHp = null;
  }

  // ── Críticos ─────────────────────────────────────────────────────────────
  //
  // Bolsa de canicas (marble bag, de candlesan) en vez de una tirada independiente: la bolsa
  // tiene el % de canicas de crítico (20 % → 2 de 10, ver critBag) y cada ataque que impacta
  // saca una al azar y no la devuelve. Si es de crítico, la bolsa se rellena; si no, queda
  // una normal menos y el siguiente tiene más probabilidad (20 %, 22 %, 25 %… seguro al 9.º).
  // Se rellena también al empezar o acabar un combate. Cada unidad lleva su bolsa.

  /** % de crítico (la estadística: la probabilidad con la bolsa llena). */
  public getCritChance(): number {
    return this.critChance;
  }

  /** Probabilidad (0-1) de que el próximo ataque que impacte sea crítico. */
  public getNextCritChance(): number {
    if (this.critChance <= 0) return 0;
    if (this.bagMarbles <= 0) this.refillCritBag();
    return this.bagCrits / this.bagMarbles;
  }

  /** Para pruebas: fija el % de crítico (y rellena la bolsa). */
  public setCritChance(percent: number): void {
    this.critChance = Math.max(0, percent);
    if (this.stats) this.stats = this.computeStats();
    this.refillCritBag();
  }

  /** Saca una canica de la bolsa para un ataque que ha impactado. */
  public rollCrit(): boolean {
    if (this.critChance <= 0) return false;
    const crit = Math.random() < this.getNextCritChance();
    if (crit) this.refillCritBag();
    else this.bagMarbles--;
    return crit;
  }

  /** Rellena la bolsa (al salir un crítico, empezar o acabar un combate). */
  public resetCritChance(): void {
    this.refillCritBag();
  }

  private refillCritBag(): void {
    const [crits, marbles] = critBag(this.critChance / 100);
    this.bagCrits = crits;
    this.bagMarbles = marbles;
  }

  // ── Estados ──────────────────────────────────────────────────────────────

  public getStatus(id: UnitStatusId): UnitStatus | null {
    return this.statuses.get(id) ?? null;
  }

  public hasStatus(id: UnitStatusId): boolean {
    return this.statuses.has(id);
  }

  public getStatuses(): UnitStatus[] {
    return [...this.statuses.values()];
  }

  /** Aplica (o renueva, quedándose con la duración mayor) un estado. */
  public addStatus(id: UnitStatusId, turns: number, source: Entity | null = null): void {
    const current = this.statuses.get(id);
    this.statuses.set(id, { id, turns: Math.max(turns, current?.turns ?? 0), source });
  }

  public removeStatus(id: UnitStatusId): void {
    this.statuses.delete(id);
  }

  /** Acaba un turno de la unidad: los estados se consumen. Devuelve los que han expirado. */
  public tickStatuses(): UnitStatusId[] {
    const expired: UnitStatusId[] = [];
    for (const status of this.statuses.values()) {
      status.turns--;
      if (status.turns <= 0) expired.push(status.id);
    }
    for (const id of expired) this.statuses.delete(id);
    return expired;
  }

  public clearStatuses(): void {
    this.statuses.clear();
  }

  public getAttacks(): readonly UnitAttack[] {
    return this.attacks;
  }

  /** Ataque por id (sin id: el de por defecto, el primero). */
  public getAttack(id?: string | null): UnitAttack | null {
    if (!id) return this.attacks[0] ?? null;
    return this.attacks.find((a) => a.id === id) ?? null;
  }

  public getHealth(): HealthComponent | null {
    return this.getOwner().getComponent('health') as HealthComponent | null;
  }

  public getHp(): number {
    return this.getHealth()?.getHp() ?? 0;
  }

  public getMaxHp(): number {
    return this.getHealth()?.getMaxHp() ?? 0;
  }

  /** Los enemigos a 0 PV mueren; los de la party quedan caídos. En ambos casos: no viva. */
  public isAlive(): boolean {
    return !this.down;
  }

  public getCapsuleRadius(): number {
    const capsule = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent | null;
    return capsule?.getCapsuleRadius() ?? 0.35;
  }

  /** Distancia vertical de los pies al pivote (centro de la cápsula). */
  public getFeetOffset(): number {
    return this.feetOffset ?? 0.9;
  }

  /** Posición de mundo del pivote de la unidad (centro de la cápsula). */
  public getPosition(out: vec3 = vec3.create()): vec3 {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return vec3.zero(out);
    return vec3.copy(out, transform.getTransform().getWorldPosition());
  }

  /** Punto del suelo bajo la unidad (donde empiezan los caminos del navmesh). */
  public getFeetPosition(out: vec3 = vec3.create()): vec3 {
    this.getPosition(out);
    out[1] = out[1]! - (this.feetOffset ?? 0.9);
    return out;
  }

  // ── Acciones ─────────────────────────────────────────────────────────────

  /**
   * Recorre un camino (puntos en el suelo, p.ej. de AStar.findPath). Devuelve una promesa
   * que se resuelve al llegar (o al interrumpirse con stop()).
   */
  public moveAlong(path: vec3[], options: MoveOptions = {}): Promise<void> {
    this.stop();
    if (path.length < 2) return Promise.resolve();
    this.path = path.map((p) => vec3.clone(p));
    this.pathIndex = 1;
    this.pathSpeed = options.speed ?? this.moveSpeed;
    this.pathTurns = options.face ?? true;
    this.pathWalk = options.walk ?? true;
    const slide = options.slide ?? 0;
    this.pathDecel = slide > 0 ? (this.pathSpeed * this.pathSpeed) / (2 * slide) : 0;
    this.pathTravelled = 0;
    this.pathLength = 0;
    for (let i = 1; i < this.path.length; i++) {
      this.pathLength += vec3.distance(this.path[i - 1]!, this.path[i]!);
    }
    this.pathSpin = options.spin ?? 0;
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (transform) quat.copy(this.spinStart, transform.getTransform().getLocalRotation());
    this.getFeetPosition(this.movingFeet);
    if (this.pathWalk) this.getAnimator()?.setParameter('moving', true);
    return new Promise((resolve) => (this.onArrive = resolve));
  }

  public stop(): void {
    if (this.path.length === 0) return;
    this.path = [];
    this.getAnimator()?.setParameter('moving', false);
    const done = this.onArrive;
    this.onArrive = null;
    done?.();
  }

  /** Mira hacia un punto (solo giro en el plano). */
  public faceTowards(point: vec3): void {
    this.getPosition(this.tmp);
    vec3.sub(this.tmpDir, point, this.tmp);
    this.faceDirection(this.tmpDir);
  }

  /**
   * Reproduce una animación de acción (ataque, golpe recibido) encima de la actual. Durante
   * `busyTime` segundos la unidad cuenta como ocupada (el turno no acaba a mitad).
   */
  public playAction(clip: string | undefined, busyTime = 0): void {
    this.actionTimer = Math.max(this.actionTimer, busyTime);
    const animator = this.getAnimator();
    if (!clip || !animator?.hasClip(clip)) return;
    animator.addLayer(clip, { loop: false, blendInTime: 0.12 });
  }

  /**
   * Cae (0 PV) o se levanta. Caída: animación de muerte y sin colisión, así no tapa el
   * picking ni los caminos. Al levantarse recupera `hp` PV (default: toda la vida).
   */
  public setDown(down: boolean, hp?: number): void {
    if (down === this.down) return;
    this.down = down;
    this.stop();
    if (down) this.clearStatuses();
    this.actionTimer = 0;
    const capsule = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent | null;
    capsule?.getCollider()?.setEnabled(!down);
    const animator = this.getAnimator();
    animator?.setParameter('dead', down);
    if (this.hideWhenDown) setRenderVisible(this.getOwner(), !down);
    if (!down) {
      this.getHealth()?.restore(hp);
      animator?.play(); // el clip de muerte (sin loop) había parado el animator
    }
  }

  /** Vuelve al punto de partida con toda la vida (reiniciar el encuentro). */
  public resetToSpawn(): void {
    this.stop();
    this.clearCooldowns();
    this.clearStatuses();
    this.resetCritChance();
    this.setDown(false);
    this.getHealth()?.restore();
    this.actionTimer = 0;
    if (!this.spawn) return;
    const feet = vec3.clone(this.spawn.position);
    feet[1] = feet[1]! - (this.feetOffset ?? 0.9);
    this.setFeetPosition(feet);
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    transform?.getTransform().setLocalPosition(this.spawn.position);
    transform?.getTransform().setLocalRotation(this.spawn.rotation);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private saveSpawn(): void {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return;
    this.spawn = {
      position: this.getPosition(vec3.create()),
      rotation: quat.clone(transform.getTransform().getLocalRotation()),
    };
  }

  private advanceAlongPath(dt: number): void {
    const feet = this.movingFeet;
    // Deslizando: v² = v0² − 2·a·s (frenada constante).
    const speed =
      this.pathDecel > 0
        ? Math.sqrt(
            Math.max(
              SLIDE_MIN_SPEED * SLIDE_MIN_SPEED,
              this.pathSpeed * this.pathSpeed - 2 * this.pathDecel * this.pathTravelled,
            ),
          )
        : this.pathSpeed;
    let budget = speed * dt;
    this.pathTravelled += budget;

    while (budget > 0 && this.pathIndex < this.path.length) {
      const target = this.path[this.pathIndex]!;
      vec3.sub(this.tmpDir, target, feet);
      const dist = vec3.length(this.tmpDir);
      if (dist <= budget) {
        vec3.copy(feet, target);
        budget -= dist;
        this.pathIndex++;
      } else {
        vec3.scaleAndAdd(feet, feet, this.tmpDir, budget / dist);
        budget = 0;
      }
      if (this.pathTurns) this.faceDirection(this.tmpDir);
    }

    this.setFeetPosition(feet);
    if (this.pathSpin !== 0 && this.pathLength > 0) {
      const t = Math.min(1, this.pathTravelled / this.pathLength);
      quat.setAxisAngle(this.tmpRot, UP, this.pathSpin * t);
      quat.multiply(this.tmpRot, this.tmpRot, this.spinStart);
      const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
      transform?.getTransform().setLocalRotation(this.tmpRot);
    }
    if (this.pathIndex >= this.path.length) this.stop();
  }

  private setFeetPosition(feet: vec3): void {
    const center = { x: feet[0]!, y: feet[1]! + (this.feetOffset ?? 0.9), z: feet[2]! };
    const capsule = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent | null;
    const body = capsule?.getRigidBody();
    if (body) {
      // Los kinematic del motor son velocity-based (ignoran setNextKinematicTranslation):
      // se recoloca el cuerpo y ColliderComponent copia la posición al transform.
      body.setTranslation(center, true);
    } else {
      const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
      transform?.getTransform().setLocalPosition(vec3.fromValues(center.x, center.y, center.z));
    }
  }

  private faceDirection(dir: vec3): void {
    if (Math.abs(dir[0]!) + Math.abs(dir[2]!) < 1e-4) return;
    const yaw = Math.atan2(dir[0]!, dir[2]!);
    quat.setAxisAngle(this.tmpRot, UP, yaw);
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    transform?.getTransform().setLocalRotation(this.tmpRot);
  }

  private computeFeetOffset(): void {
    const pos = this.getPosition(this.tmp);
    const ground = groundHeightAt(pos[0]!, pos[2]!, pos[1]!);
    this.feetOffset = ground !== null ? pos[1]! - ground : 0.9;
  }

  /** Silueta según el bando; los caídos no tienen. */
  private updateSilhouette(): void {
    const wanted = this.silhouette && !this.down ? (SILHOUETTES[this.faction] ?? null) : null;
    if (wanted === this.silhouetteShown) return;
    this.silhouetteShown = wanted;
    this.getSkeletalMesh()?.setSilhouette(wanted);
  }

  private getSkeletalMesh(): SkeletalMeshComponent | null {
    const find = (e: Entity): SkeletalMeshComponent | null =>
      (e.getComponent('skeletal_mesh') as SkeletalMeshComponent | null) ??
      e
        .getChildren()
        .map(find)
        .find((m) => m !== null) ??
      null;
    return find(this.getOwner());
  }

  public getAnimator(): AnimatorComponent | null {
    const find = (e: Entity): AnimatorComponent | null =>
      (e.getComponent('animator') as AnimatorComponent | null) ??
      e
        .getChildren()
        .map(find)
        .find((a) => a !== null) ??
      null;
    return find(this.getOwner());
  }

  /** Todas las unidades de la escena: primero la party, después enemigos y neutrales. */
  public static getAll(): UnitComponent[] {
    const list = (Engine.getEntities().getObjectManagerByName('unit')?.getList() ??
      []) as UnitComponent[];
    const order: Record<UnitFaction, number> = { party: 0, enemy: 1, neutral: 2 };
    return [...list].sort((a, b) => order[a.faction] - order[b.faction]);
  }
}

/**
 * Bolsa de crítico para una probabilidad `p` (0-1): [canicas de crítico, canicas en total].
 * Diez canicas con el % de crítico (20 % → 2 de 10); si el % no cabe en diez, las que hagan
 * falta para que salga exacto (15 % → 3 de 20, 33 % → 33 de 100).
 */
export function critBag(p: number): [number, number] {
  const percent = Math.round(Math.min(1, p) * 100);
  let size = 10;
  while ((percent * size) % 100 !== 0) size += 10;
  return [(percent * size) / 100, size];
}

/** Derivados de los atributos (GDD §3). */
export interface UnitStats {
  maxHp: number;
  movement: number;
  /** % de crítico con la bolsa llena. */
  critChance: number;
  penetration: number;
  /** Parte fija de la iniciativa (2·REF), sin el 1d4. */
  initiative: number;
  /** Turnos extra de los estados que aplica. */
  statusBonusTurns: number;
  armor: number;
}

const NO_ATTRIBUTES: Readonly<Attributes> = makeAttributes();

/** Materiales de silueta por bando (los neutrales, como los objetos, no tienen). */
const SILHOUETTES: Partial<Record<UnitFaction, string>> = {
  party: 'tactical_silhouette_ally.mat',
  enemy: 'tactical_silhouette_enemy.mat',
};

/** Muestra u oculta todos los RenderComponent de una entidad y sus hijos. */
function setRenderVisible(entity: Entity, visible: boolean): void {
  (entity.getComponent('render') as RenderComponent | null)?.setVisible(visible);
  entity.getChildren().forEach((c) => setRenderVisible(c, visible));
}
