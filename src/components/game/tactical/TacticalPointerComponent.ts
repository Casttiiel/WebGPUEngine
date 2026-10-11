import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { screenPointToRay } from '../../../core/math/ScreenRay';
import { MouseButton } from '../../../types/MouseButton.enum';
import { Render } from '../../../renderer/core/pipeline/Render';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { SkeletalMeshComponent } from '../../render/SkeletalMeshComponent';
import { UnitComponent } from './UnitComponent';
import { PartyComponent } from './PartyComponent';
import { GroundMarker } from './GroundMarker';
import { EncounterComponent, type MovePlan } from './EncounterComponent';
import { NavMesh } from '../../../ai/nav/NavMesh';
import { PathPreview } from './PathPreview';

/** Qué hay bajo el cursor. */
export type HoverKind = 'none' | 'ui' | 'ally' | 'enemy' | 'neutral' | 'ground' | 'invalid';

/** Cursor mostrado para cada tipo de hover. */
export type CursorKind = 'default' | 'select' | 'move' | 'attack' | 'invalid';

export type TacticalPointerComponentDataType = Readonly<{
  /** Cuánto se aclara el personaje bajo el cursor (0-1). Default 0.35. */
  hoverHighlight?: number;
}>;

// Cursores SVG (hotspot en la punta de la flecha / centro de la mira).
const ARROW = 'M3 2 L3 21 L8 16.5 L11.5 24 L14.5 22.6 L11.2 15.4 L17.5 15.4 Z';
const svgCursor = (body: string, hx: number, hy: number, fallback: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>${body}</svg>`,
  )}") ${hx} ${hy}, ${fallback}`;

const CURSORS: Record<CursorKind, string> = {
  default: 'default',
  select: 'pointer',
  move: svgCursor(
    `<path d='${ARROW}' fill='white' stroke='black' stroke-width='1.2'/><circle cx='22' cy='24' r='5' fill='#66dd77' stroke='black' stroke-width='1.2'/>`,
    3,
    2,
    'default',
  ),
  attack: svgCursor(
    `<circle cx='16' cy='16' r='9' fill='none' stroke='black' stroke-width='4'/><circle cx='16' cy='16' r='9' fill='none' stroke='#ff4a3d' stroke-width='2.2'/><path d='M16 2 V9 M16 23 V30 M2 16 H9 M23 16 H30' stroke='#ff4a3d' stroke-width='2.2'/>`,
    16,
    16,
    'crosshair',
  ),
  invalid: 'not-allowed',
};

const CURSOR_FOR_HOVER: Record<HoverKind, CursorKind> = {
  none: 'default',
  ui: 'default',
  ally: 'select',
  enemy: 'attack',
  neutral: 'default',
  ground: 'move',
  invalid: 'invalid',
};

/**
 * TacticalPointerComponent — el ratón del jugador en el mundo táctico:
 *  - picking (rayo desde el cursor contra la física) para saber qué hay debajo,
 *  - cursor contextual (seleccionar aliado / atacar enemigo / mover / no válido),
 *  - resaltado del personaje bajo el cursor + anillo de hover (azul aliado, rojo enemigo),
 *  - vista previa del camino al suelo bajo el cursor (y metros en combate),
 *  - click en un miembro de la party → seleccionarlo; click en el suelo → moverse.
 * Las reglas (quién se mueve, cuánto) son de EncounterComponent. Atacar: punto 12.
 */
export class TacticalPointerComponent extends Component {
  private hoverHighlight = 0.35;

  private hoverKind: HoverKind = 'none';
  private hoveredUnit: Entity | null = null;
  private hoverPoint = vec3.create();
  private cursor: CursorKind = 'default';

  private allyRing = new GroundMarker('tactical/ring_hover_ally.prefab');
  private enemyRing = new GroundMarker('tactical/ring_hover_enemy.prefab');
  private preview: PathPreview | null = null;
  private movePlan: MovePlan | null = null;
  private initialized = false;
  private readonly tmpPos = vec3.create();

  public load(data: TacticalPointerComponentDataType): void {
    this.hoverHighlight = data.hoverHighlight ?? this.hoverHighlight;
  }

  public update(_dt: number): void {
    if (!this.initialized) {
      this.initialized = true;
      void this.allyRing.spawn();
      void this.enemyRing.spawn();
      this.preview = new PathPreview();
    }

    const inGameplay = Engine.getModules().getCurrentGamestate() === 'gs_gameplay';
    this.pick(inGameplay);
    this.applyFeedback();

    if (inGameplay && Engine.getInput().isMouseButtonJustPressed(MouseButton.LEFT)) {
      this.handleClick();
    }
  }

  // ── API (asserts del MCP, UI, fases siguientes) ──────────────────────────

  public getHoverKind(): HoverKind {
    return this.hoverKind;
  }

  public getHoveredUnit(): Entity | null {
    return this.hoveredUnit;
  }

  public getHoveredName(): string | null {
    return this.hoveredUnit?.getName() ?? null;
  }

  /** Punto del mundo bajo el cursor (válido si hoverKind es 'ground' o 'invalid'). */
  public getHoverPoint(): vec3 {
    return this.hoverPoint;
  }

  public getCursor(): CursorKind {
    return this.cursor;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private pick(inGameplay: boolean): void {
    this.hoveredUnit = null;
    this.movePlan = null;
    const input = Engine.getInput();
    if (!inGameplay || !input.isMouseInWindow()) {
      this.hoverKind = 'none';
      return;
    }
    if (ModuleUI.getInstance()?.getInputManager().getHoveredWidget()) {
      this.hoverKind = 'ui';
      return;
    }

    const mouse = input.getMousePosition();
    const ray = screenPointToRay(mouse.x, mouse.y, Engine.getRender().getMainCamera());
    const result = Engine.getPhysics().raycastClosestNonSensor(ray.origin, ray.direction, 1000);
    if (!result) {
      this.hoverKind = 'none';
      return;
    }

    const unit = findUnit(Engine.getEntities().getEntityById(result.entityId));
    if (unit) {
      this.hoveredUnit = unit.getOwner();
      const party = PartyComponent.find();
      this.hoverKind =
        unit.getFaction() === 'enemy'
          ? 'enemy'
          : party?.isMember(unit.getOwner()) || unit.getFaction() === 'party'
            ? 'ally'
            : 'neutral';
      return;
    }

    vec3.scaleAndAdd(this.hoverPoint, ray.origin, ray.direction, result.hit.timeOfImpact);
    this.movePlan = this.planMoveTo(this.hoverPoint);
    const m = this.movePlan;
    this.hoverKind = m && m.allowed && m.plan.reachable && m.affordable ? 'ground' : 'invalid';
  }

  // Caché del plan: el camino solo se recalcula si cambia el punto, quién actúa, el
  // estado del encuentro, el presupuesto o el navmesh (p.ej. una unidad se ha movido).
  private planCache = {
    point: vec3.fromValues(Infinity, 0, 0),
    key: '',
    plan: null as MovePlan | null,
  };

  /** Plan de movimiento del seleccionado hasta `point` (null si no hay encuentro/selección). */
  private planMoveTo(point: vec3): MovePlan | null {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!encounter || !selected) return null;
    const key = `${selected.id}|${encounter.getState()}|${encounter.getActiveUnitName()}|${encounter.getResources().movement.toFixed(2)}|${NavMesh.getInstance().getVersion()}`;
    const c = this.planCache;
    if (c.key === key && vec3.squaredDistance(c.point, point) < 0.1 * 0.1) return c.plan;
    vec3.copy(c.point, point);
    c.key = key;
    c.plan = encounter.planMove(selected, point);
    return c.plan;
  }

  private lastHighlighted: Entity | null = null;

  private applyFeedback(): void {
    // Cursor
    const cursor = CURSOR_FOR_HOVER[this.hoverKind];
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      Render.getInstance().getCanvas().style.cursor = CURSORS[cursor];
    }

    // Resaltado del personaje bajo el cursor
    if (this.hoveredUnit !== this.lastHighlighted) {
      if (this.lastHighlighted) setUnitHighlight(this.lastHighlighted, 0);
      if (this.hoveredUnit) setUnitHighlight(this.hoveredUnit, this.hoverHighlight);
      this.lastHighlighted = this.hoveredUnit;
    }

    // Anillo de hover (no sobre el seleccionado: ya tiene el suyo)
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const unit = this.hoveredUnit?.getComponent('unit') as UnitComponent | null;
    const showRing = unit && this.hoveredUnit !== selected;
    if (showRing && this.hoverKind === 'enemy') {
      this.enemyRing.showAt(unit.getPosition(this.tmpPos));
      this.allyRing.hide();
    } else if (showRing && this.hoverKind === 'ally') {
      this.allyRing.showAt(unit.getPosition(this.tmpPos));
      this.enemyRing.hide();
    } else {
      this.allyRing.hide();
      this.enemyRing.hide();
    }

    // Vista previa del camino: solo si la unidad puede moverse y hay camino (aunque no llegue
    // el presupuesto: el tramo que sobra se pinta en rojo).
    const m = this.movePlan;
    const showPath =
      (this.hoverKind === 'ground' || this.hoverKind === 'invalid') &&
      m &&
      m.allowed &&
      m.plan.reachable;
    if (showPath) {
      const inCombat = EncounterComponent.find()?.isInCombat() ?? false;
      this.preview?.show(
        m.plan.points,
        m.budget,
        inCombat ? `${m.plan.length.toFixed(1)} M` : null,
      );
    } else {
      this.preview?.hide();
    }
  }

  private handleClick(): void {
    if (this.hoverKind === 'ally' && this.hoveredUnit) {
      PartyComponent.find()?.select(this.hoveredUnit, 'world');
    } else if (this.hoverKind === 'ground') {
      const selected = PartyComponent.find()?.getSelected();
      if (selected) EncounterComponent.find()?.requestMove(selected, this.hoverPoint);
      this.planCache.key = ''; // el presupuesto ha cambiado
    }
    // 'enemy' → atacar: punto 12.
  }

  public override dispose(): void {
    this.allyRing.destroy();
    this.enemyRing.destroy();
    this.preview?.destroy();
    if (this.lastHighlighted) setUnitHighlight(this.lastHighlighted, 0);
    Render.getInstance().getCanvas().style.cursor = 'default';
  }
}

/** La unidad a la que pertenece una entidad (ella misma o un ancestro). */
function findUnit(entity: Entity | null): UnitComponent | null {
  for (let e = entity; e; e = e.getParent()) {
    const unit = e.getComponent('unit') as UnitComponent | null;
    if (unit) return unit;
  }
  return null;
}

function setUnitHighlight(unit: Entity, amount: number): void {
  const visit = (e: Entity) => {
    (e.getComponent('skeletal_mesh') as SkeletalMeshComponent | null)?.setHighlight(amount);
    e.getChildren().forEach(visit);
  };
  visit(unit);
}
