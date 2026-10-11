import { quat, vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import { HealthComponent } from '../HealthComponent';
import { RenderComponent } from '../../render/RenderComponent';
import { groundHeightAt } from './TacticalQueries';

export type UnitFaction = 'party' | 'enemy' | 'neutral';

/** Un ataque de la unidad (arma). Sin stats: alcance y daño fijos. */
export interface UnitAttack {
  /** Identificador ('melee', 'ranged'…). */
  id: string;
  /** Nombre visible (hotbar, tooltips). */
  name: string;
  /** Cuerpo a cuerpo (se puede acercar y atacar) o a distancia (requiere línea de visión). */
  kind: 'melee' | 'ranged';
  /** Alcance en metros, de borde a borde de las cápsulas. */
  range: number;
  damage: number;
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
  /** Velocidad al andar (m/s). Default 4. */
  moveSpeed?: number;
  /** Metros de movimiento por turno en combate. Default 9 (como en BG3). */
  movement?: number;
  /** Distancia a la que detecta a unidades enemigas (m). 0 = no detecta. Default: 8 enemigos, 0 resto. */
  sightRange?: number;
  /** Ataques (orden de la hotbar; el primero es el de por defecto). Default: un golpe cuerpo a cuerpo. */
  attacks?: UnitAttack[];
  /** Acciones de la hotbar además de los ataques: saltar, empujar objetos. Default: ninguna. */
  abilities?: UnitAbility[];
  /** Al caer desaparece (objetos destruidos, p.ej. un barril que explota). Default false. */
  hideWhenDown?: boolean;
}>;

/** Acciones que no son ataques: saltar (gasta movimiento) y empujar un objeto (acción adicional). */
export type UnitAbility = 'jump' | 'push';

export interface MoveOptions {
  /** Velocidad (m/s). Default: la de la unidad. */
  speed?: number;
  /** Animación de andar. Default true (false: saltos, objetos empujados). */
  walk?: boolean;
  /** Girarse hacia donde avanza. Default true. */
  face?: boolean;
}

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
  private moveSpeed = 4;
  private movement = 9;
  private sightRange = 0;
  private attacks: UnitAttack[] = DEFAULT_ATTACKS;
  private down = false;
  private abilities: UnitAbility[] = [];
  private hideWhenDown = false;
  private pathSpeed = 4;
  private pathTurns = true;
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
    this.moveSpeed = data.moveSpeed ?? this.moveSpeed;
    this.movement = data.movement ?? this.movement;
    this.sightRange = data.sightRange ?? (this.faction === 'enemy' ? 8 : 0);
    this.attacks = data.attacks ? data.attacks.map((a) => ({ ...a })) : DEFAULT_ATTACKS;
    this.abilities = [...(data.abilities ?? [])];
    this.hideWhenDown = data.hideWhenDown ?? false;
  }

  public update(dt: number): void {
    if (this.feetOffset === null) this.computeFeetOffset();
    if (!this.spawn) this.saveSpawn();
    if (this.actionTimer > 0) this.actionTimer = Math.max(0, this.actionTimer - dt);

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
    this.getFeetPosition(this.movingFeet);
    if (options.walk ?? true) this.getAnimator()?.setParameter('moving', true);
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
    let budget = this.pathSpeed * dt;

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

/** Muestra u oculta todos los RenderComponent de una entidad y sus hijos. */
function setRenderVisible(entity: Entity, visible: boolean): void {
  (entity.getComponent('render') as RenderComponent | null)?.setVisible(visible);
  entity.getChildren().forEach((c) => setRenderVisible(c, visible));
}
