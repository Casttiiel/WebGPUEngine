import { quat, vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { AnimatorComponent } from '../../render/AnimatorComponent';
import { CapsuleColliderComponent } from '../../physics/CapsuleColliderComponent';
import { groundHeightAt } from './TacticalQueries';

export type UnitFaction = 'party' | 'enemy' | 'neutral';

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
}>;

const UP = vec3.fromValues(0, 1, 0);

/**
 * UnitComponent — unidad del juego táctico (miembro de la party, enemigo o neutral).
 *
 * Sabe moverse a lo largo de un camino (cuerpo kinematic + orientación + animación de
 * andar) y dónde tiene los pies. Las reglas (quién puede moverse, cuánto) las pone
 * EncounterComponent; aquí solo está la ejecución.
 */
export class UnitComponent extends Component {
  private faction: UnitFaction = 'neutral';
  private displayName: string | null = null;
  private moveSpeed = 4;
  private movement = 9;
  private sightRange = 0;

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
  }

  public update(dt: number): void {
    if (this.feetOffset === null) this.computeFeetOffset();

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

  public getCapsuleRadius(): number {
    const capsule = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent | null;
    return capsule?.getCapsuleRadius() ?? 0.35;
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
  public moveAlong(path: vec3[]): Promise<void> {
    this.stop();
    if (path.length < 2) return Promise.resolve();
    this.path = path.map((p) => vec3.clone(p));
    this.pathIndex = 1;
    this.getFeetPosition(this.movingFeet);
    this.getAnimator()?.setParameter('moving', true);
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

  // ── Interno ──────────────────────────────────────────────────────────────

  private advanceAlongPath(dt: number): void {
    const feet = this.movingFeet;
    let budget = this.moveSpeed * dt;

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
      this.faceDirection(this.tmpDir);
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

  private getAnimator(): AnimatorComponent | null {
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
