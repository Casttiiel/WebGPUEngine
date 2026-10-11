import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { ModuleGameController } from '../../../modules/game/ModuleGameController';
import { UnitComponent } from './UnitComponent';
import { TacticalCameraControllerComponent } from './TacticalCameraControllerComponent';
import { GroundMarker } from './GroundMarker';

export type PartyComponentDataType = Readonly<{
  /** Nombres de las entidades de la party, en orden (teclas 1-4 / retratos). Default: las unidades con faction "party". */
  members?: string[];
  /** Clase de widgets de HUD a mostrar en gameplay. Default: "PARTY_HUD". */
  hud?: string;
}>;

export type SelectionSource = 'world' | 'portrait' | 'key' | 'code';

const MAX_MEMBERS = 4;
const SELECT_KEYS = [KeyCode.NUM_1, KeyCode.NUM_2, KeyCode.NUM_3, KeyCode.NUM_4];

/**
 * PartyComponent — los (hasta) 4 personajes controlados por el jugador y cuál está
 * seleccionado. La selección mueve la "unidad activa" de la cámara táctica y el anillo
 * de selección bajo sus pies.
 *
 * Entrada: teclas 1-4 seleccionan (y centran la cámara), Tab / Shift+Tab ciclan.
 * Click en un personaje y retratos llegan vía select() desde TacticalPointer y el HUD.
 */
export class PartyComponent extends Component {
  private memberNames: string[] | null = null;
  private members: Entity[] = [];
  private selected: Entity | null = null;
  private initialized = false;
  private ring: GroundMarker | null = null;
  private listeners: ((selected: Entity | null, source: SelectionSource) => void)[] = [];
  private readonly tmpPos = vec3.create();

  public load(data: PartyComponentDataType): void {
    this.memberNames = data.members ?? null;
    // El HUD táctico sustituye al HUD FPS por defecto (lo activa ModuleGameController).
    ModuleGameController.gameplayHud = data.hud ?? 'PARTY_HUD';
  }

  public update(_dt: number): void {
    if (!this.initialized) this.initialize();

    const input = Engine.getInput();
    SELECT_KEYS.forEach((key, i) => {
      if (input.isKeyJustPressed(key)) this.select(i, 'key');
    });
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
