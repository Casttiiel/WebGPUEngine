import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { ModuleGameController } from '../../../modules/game/ModuleGameController';
import { UnitComponent } from './UnitComponent';
import { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { GroundMarker } from './GroundMarker';
import { UnitObstacles } from './UnitObstacles';
import { groundHeightAt, planPath } from './TacticalQueries';

export type PartyComponentDataType = Readonly<{
  /** Nombres de las entidades de la party, en orden (teclas 1-4 / retratos). Default: las unidades con faction "party". */
  members?: string[];
  /** Clase de widgets de HUD a mostrar en gameplay. Default: "PARTY_HUD". */
  hud?: string;
  /** En exploración el resto de la party sigue al seleccionado al moverse. Default true. */
  follow?: boolean;
}>;

export type SelectionSource = 'world' | 'portrait' | 'key' | 'code';

const MAX_MEMBERS = 4;
/** Huecos de la formación de seguimiento: [metros detrás del líder, metros a su derecha]. */
const FORMATION: [number, number][] = [
  [1.4, 0.9],
  [1.4, -0.9],
  [2.8, 0],
];
/** Metros más atrás por cada vuelta a la formación (más de 3 seguidores). */
const FORMATION_ROW = 2.8;
/** Separación entre seguidores cuando se colocan sobre el camino del líder. */
const FOLLOW_SPACING = 1.3;
const SELECT_KEYS = [KeyCode.NUM_1, KeyCode.NUM_2, KeyCode.NUM_3, KeyCode.NUM_4];

/**
 * PartyComponent — los (hasta) 4 personajes controlados por el jugador y cuál está
 * seleccionado. La selección mueve la "unidad activa" de la cámara táctica y el anillo
 * de selección bajo sus pies.
 *
 * Entrada: teclas 1-4 seleccionan (y centran la cámara), Tab / Shift+Tab ciclan.
 * Click en un personaje y retratos llegan vía select() desde TacticalPointer y el HUD.
 *
 * En exploración el resto sigue al seleccionado (followLeader, lo llama EncounterComponent al
 * moverlo): van a una formación detrás de su destino.
 */
export class PartyComponent extends Component {
  private memberNames: string[] | null = null;
  private members: Entity[] = [];
  private selected: Entity | null = null;
  private initialized = false;
  private numberKeys = true;
  private follow = true;
  private ring: GroundMarker | null = null;
  private listeners: ((selected: Entity | null, source: SelectionSource) => void)[] = [];
  private readonly tmpPos = vec3.create();

  public load(data: PartyComponentDataType): void {
    this.memberNames = data.members ?? null;
    this.follow = data.follow ?? true;
    // El HUD táctico sustituye al HUD FPS por defecto (lo activa ModuleGameController).
    const hud = data.hud ?? 'PARTY_HUD';
    ModuleGameController.gameplayHuds = [
      hud,
      ...ModuleGameController.gameplayHuds.filter((h) => h !== 'HUD' && h !== hud),
    ];
  }

  public update(_dt: number): void {
    if (!this.initialized) this.initialize();

    const input = Engine.getInput();
    if (this.numberKeys) {
      SELECT_KEYS.forEach((key, i) => {
        if (input.isKeyJustPressed(key)) this.select(i, 'key');
      });
    }
    if (input.isKeyJustPressed(KeyCode.TAB) && this.members.length) {
      const shift =
        input.isKeyPressed(KeyCode.SHIFT) || input.isKeyPressed('shiftright' as KeyCode);
      const index = this.selected ? this.members.indexOf(this.selected) : -1;
      const next = (index + (shift ? -1 : 1) + this.members.length) % this.members.length;
      this.select(next, 'key');
    }

    // El anillo sigue al seleccionado (las unidades se moverán en fases posteriores).
    if (this.ring) {
      const unit = this.selected?.getComponent('unit') as UnitComponent | null;
      if (unit) this.ring.showAt(unit.getPosition(this.tmpPos));
      else this.ring.hide();
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────

  public getMembers(): Entity[] {
    return this.members;
  }

  public getSelected(): Entity | null {
    return this.selected;
  }

  public getSelectedIndex(): number {
    return this.selected ? this.members.indexOf(this.selected) : -1;
  }

  /** Nombre del seleccionado (para el MCP / asserts de escenarios). */
  public getSelectedName(): string | null {
    return this.selected?.getName() ?? null;
  }

  public getMemberNames(): string[] {
    return this.members.map((m) => m.getName());
  }

  public isMember(entity: Entity): boolean {
    return this.members.includes(entity);
  }

  /**
   * Selecciona un miembro (por índice o entidad). La cámara pasa a seguirlo.
   */
  public select(target: number | Entity, source: SelectionSource = 'code'): void {
    const entity = typeof target === 'number' ? this.members[target] : target;
    if (!entity || !this.members.includes(entity)) return;

    const changed = entity !== this.selected;
    this.selected = entity;
    // La cámara sigue siempre al personaje controlado (transición suave).
    this.getCamera()?.setActiveUnit(entity, true);
    if (changed) for (const l of this.listeners) l(entity, source);
  }

  /**
   * Exploración: el resto de la party sigue al líder hasta una formación detrás de donde va
   * (`path`: el camino que va a recorrer). Si un hueco de la formación no se puede pisar, se
   * coloca sobre el propio camino del líder, más atrás. Los caídos no se mueven.
   */
  public followLeader(leader: Entity, path: vec3[]): void {
    if (!this.follow || path.length < 2) return;
    const end = path[path.length - 1]!;
    // Dirección de llegada (último tramo con longitud) → "detrás" y "a la derecha".
    const back = vec3.create();
    for (let i = path.length - 2; i >= 0 && vec3.length(back) < 1e-3; i--) {
      vec3.sub(back, path[i]!, end);
      back[1] = 0;
    }
    if (vec3.length(back) < 1e-3) return;
    vec3.normalize(back, back);
    const right = vec3.fromValues(-back[2]!, 0, back[0]!);

    let slot = 0;
    for (const member of this.members) {
      if (member === leader) continue;
      const unit = member.getComponent('unit') as UnitComponent | null;
      if (!unit?.isAlive()) continue;
      // Sin su propio obstáculo, o se bloquearía el camino.
      UnitObstacles.sync(member);
      const from = unit.getFeetPosition(vec3.create());
      const walk = this.followPath(from, end, back, right, path, slot++);
      if (walk) void unit.moveAlong(walk);
    }
    UnitObstacles.sync(leader);
  }

  public isFollowEnabled(): boolean {
    return this.follow;
  }

  public setFollowEnabled(enabled: boolean): void {
    this.follow = enabled;
  }

  /** Teclas 1-4 para seleccionar. En combate se apagan: son las de la hotbar. */
  public setNumberKeysEnabled(enabled: boolean): void {
    this.numberKeys = enabled;
  }

  public onSelectionChanged(
    listener: (selected: Entity | null, source: SelectionSource) => void,
  ): void {
    this.listeners.push(listener);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private initialize(): void {
    this.initialized = true;
    const entities = Engine.getEntities();
    this.members = this.memberNames
      ? this.memberNames
          .map((n) => entities.getEntityByName(n))
          .filter((e): e is Entity => e !== null)
      : UnitComponent.getAll()
          .filter((u) => u.getFaction() === 'party')
          .map((u) => u.getOwner());
    if (this.members.length > MAX_MEMBERS) this.members = this.members.slice(0, MAX_MEMBERS);

    this.ring = new GroundMarker('tactical/ring_selected.prefab');
    void this.ring.spawn();

    if (this.members.length) this.select(0, 'code');
  }

  /**
   * Camino de un seguidor a su hueco `slot` de la formación; si no se puede, a un punto del
   * camino del líder más atrás. null si no hay a dónde ir (o ya está ahí).
   */
  private followPath(
    from: vec3,
    end: vec3,
    back: vec3,
    right: vec3,
    leaderPath: vec3[],
    slot: number,
  ): vec3[] | null {
    const candidates: vec3[] = [];
    const [behind, side] = FORMATION[slot % FORMATION.length]!;
    const row = Math.floor(slot / FORMATION.length) * FORMATION_ROW;
    const formation = vec3.scaleAndAdd(vec3.create(), end, back, behind + row);
    vec3.scaleAndAdd(formation, formation, right, side);
    candidates.push(formation);
    for (let k = 0; k < 3; k++) {
      candidates.push(pointBackAlong(leaderPath, FOLLOW_SPACING * (slot + 1 + k)));
    }
    for (const c of candidates) {
      // Suelo a la altura del líder (no encima de cajas o muros).
      c[1] = groundHeightAt(c[0]!, c[2]!, end[1]! + 1) ?? end[1]!;
      if (Math.hypot(c[0]! - from[0]!, c[2]! - from[2]!) < 0.3) return null;
      const plan = planPath(from, c);
      if (plan.reachable && plan.points.length >= 2) return plan.points;
    }
    return null;
  }

  private getCamera(): TacticalCameraControllerComponent | null {
    const list = Engine.getEntities()
      .getObjectManagerByName('tactical_camera_controller')
      ?.getList();
    return (list?.[0] as TacticalCameraControllerComponent | undefined) ?? null;
  }

  public override dispose(): void {
    this.ring?.destroy();
    this.listeners = [];
  }

  /** Utilidad para otros componentes: la party de la escena (si hay). */
  public static find(): PartyComponent | null {
    const list = Engine.getEntities().getObjectManagerByName('party')?.getList();
    return (list?.[0] as PartyComponent | undefined) ?? null;
  }
}

/** Punto del camino a `distance` metros (andando hacia atrás) de su final. */
function pointBackAlong(path: vec3[], distance: number): vec3 {
  let left = distance;
  for (let i = path.length - 1; i > 0; i--) {
    const a = path[i]!;
    const b = path[i - 1]!;
    const length = vec3.distance(a, b);
    if (length >= left) return vec3.lerp(vec3.create(), a, b, left / length);
    left -= length;
  }
  return vec3.clone(path[0]!);
}
