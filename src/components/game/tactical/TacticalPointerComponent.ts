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
import { EncounterComponent, type AttackPlan, type MovePlan } from './EncounterComponent';
import { NavMesh } from '../../../ai/nav/NavMesh';
import { PathPreview } from './PathPreview';
import { KeyCode } from '../../../types/KeyCode.enum';

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

/** Motivos de AttackPlan → texto del tooltip. */
const REASON_TEXT: Record<string, string> = {
  'target out of range': 'fuera de alcance',
  'no line of sight': 'sin línea de visión',
  'target out of reach': 'no llega',
  'no action left': 'sin acción',
  'no bonus action left': 'sin acción adicional',
  'not this unit’s turn': 'no es su turno',
  'unit is busy': 'ocupado',
  'unit is down': 'caído',
};

const HOTBAR_KEYS = [
  KeyCode.NUM_1,
  KeyCode.NUM_2,
  KeyCode.NUM_3,
  KeyCode.NUM_4,
  KeyCode.NUM_5,
  KeyCode.NUM_6,
];

/**
 * TacticalPointerComponent — el ratón del jugador en el mundo táctico:
 *  - picking (rayo desde el cursor contra la física) para saber qué hay debajo,
 *  - cursor contextual (seleccionar aliado / atacar enemigo / mover / no válido),
 *  - resaltado del personaje bajo el cursor + anillo de hover (azul aliado, rojo enemigo),
 *  - vista previa del camino al suelo bajo el cursor (y metros en combate),
 *  - tooltip del objetivo (vida, % de impacto, daño o por qué no se puede atacar),
 *  - click en un miembro de la party → seleccionarlo; en el suelo → moverse; en un enemigo
 *    → atacar con el ataque armado (si es cuerpo a cuerpo y no llega, se acerca y ataca).
 * Ataque armado: el primero de la unidad por defecto; la hotbar (teclas 1-6 en combate)
 * arma otro; Esc o click derecho vuelven al de por defecto.
 * Las reglas (quién se mueve o ataca, cuánto) son de EncounterComponent.
 */
export class TacticalPointerComponent extends Component {
  private hoverHighlight = 0.35;

  private hoverKind: HoverKind = 'none';
  private hoveredUnit: Entity | null = null;
  /** Unidad señalada desde la UI (barra de iniciativa): se resalta en el mundo. */
  private uiHoverUnit: Entity | null = null;
  private hoverPoint = vec3.create();
  private cursor: CursorKind = 'default';
  private armedAttack: string | null = null;
  private armedFor: Entity | null = null;
  private attackPlan: AttackPlan | null = null;

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
    if (inGameplay) this.handleHotbarInput();
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

  /** Ataque armado del seleccionado (id); null = el de por defecto. */
  public getArmedAttack(): string | null {
    this.syncArmedOwner();
    return this.armedAttack;
  }

  /** Arma un ataque para el próximo click en un enemigo (hotbar). Repetir lo desarma. */
  public armAttack(id: string | null): void {
    this.syncArmedOwner();
    this.armedAttack = id === this.armedAttack ? null : id;
  }

  /** Resalta en el mundo una unidad señalada desde la UI (null: ninguna). */
  public setUiHoverUnit(unit: Entity | null): void {
    this.uiHoverUnit = unit;
  }

  /** Último plan de ataque bajo el cursor (asserts, UI). */
  public getAttackPlan(): AttackPlan | null {
    return this.attackPlan;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** El ataque armado es del seleccionado: al cambiar de unidad (o de turno) se desarma. */
  private syncArmedOwner(): void {
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (selected !== this.armedFor) {
      this.armedFor = selected;
      this.armedAttack = null;
    }
  }

  private handleHotbarInput(): void {
    const input = Engine.getInput();
    if (
      input.isKeyJustPressed(KeyCode.ESCAPE) ||
      input.isMouseButtonJustPressed(MouseButton.RIGHT)
    ) {
      this.armAttack(null);
    }
    const encounter = EncounterComponent.find();
    if (!encounter?.isInCombat() || !encounter.isPlayerTurn()) return;
    const unit = PartyComponent.find()?.getSelected()?.getComponent('unit') as
      | UnitComponent
      | null
      | undefined;
    const attacks = unit?.getAttacks() ?? [];
    HOTBAR_KEYS.forEach((key, i) => {
      const attack = attacks[i];
      if (attack && input.isKeyJustPressed(key)) this.armAttack(attack.id);
    });
  }

  private pick(inGameplay: boolean): void {
    this.hoveredUnit = null;
    this.movePlan = null;
    this.attackPlan = null;
    const input = Engine.getInput();
    if (!inGameplay || !input.isMouseInWindow()) {
      this.hoverKind = 'none';
      return;
    }
    if (ModuleUI.getInstance()?.getWidgetUnderMouse()) {
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
      if (this.hoverKind === 'enemy') this.attackPlan = this.planAttackOn(unit.getOwner());
      return;
    }

    vec3.scaleAndAdd(this.hoverPoint, ray.origin, ray.direction, result.hit.timeOfImpact);
    this.movePlan = this.planMoveTo(this.hoverPoint);
    const m = this.movePlan;
    // Válido si se puede avanzar, aunque sea solo parte del camino (se para donde llegue).
    this.hoverKind = m && m.canMove ? 'ground' : 'invalid';
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

  private attackCache = { key: '', plan: null as AttackPlan | null };

  /** Plan de ataque del seleccionado contra `target` con el ataque armado (cacheado). */
  private planAttackOn(target: Entity): AttackPlan | null {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!encounter || !selected) return null;
    const a = (selected.getComponent('unit') as UnitComponent).getPosition(vec3.create());
    const b = (target.getComponent('unit') as UnitComponent).getPosition(vec3.create());
    const r = encounter.getResources();
    const key = [
      selected.id,
      target.id,
      this.getArmedAttack(),
      encounter.getState(),
      encounter.getActiveUnitName(),
      r.action,
      r.bonusAction,
      r.movement.toFixed(2),
      NavMesh.getInstance().getVersion(),
      (selected.getComponent('unit') as UnitComponent).isBusy(),
      ...[...a, ...b].map((v) => v.toFixed(2)),
    ].join('|');
    if (this.attackCache.key !== key) {
      this.attackCache.key = key;
      this.attackCache.plan = encounter.planAttack(selected, target, this.getArmedAttack());
    }
    return this.attackCache.plan;
  }

  private lastHighlighted: Entity | null = null;

  private applyFeedback(): void {
    // Cursor: sobre un enemigo, atacar solo si se puede.
    let cursor = CURSOR_FOR_HOVER[this.hoverKind];
    if (this.hoverKind === 'enemy' && this.attackPlan && !this.attackPlan.canAttack) {
      cursor = 'invalid';
    }
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      Render.getInstance().getCanvas().style.cursor = CURSORS[cursor];
    }

    // Resaltado del personaje bajo el cursor (o señalado desde la UI)
    const focus = this.hoveredUnit ?? (this.hoverKind === 'ui' ? this.uiHoverUnit : null);
    if (focus !== this.lastHighlighted) {
      if (this.lastHighlighted) setUnitHighlight(this.lastHighlighted, 0);
      if (focus) setUnitHighlight(focus, this.hoverHighlight);
      this.lastHighlighted = focus;
    }

    // Anillo de hover (no sobre el seleccionado: ya tiene el suyo)
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const unit = focus?.getComponent('unit') as UnitComponent | null;
    const showRing = unit && focus !== selected;
    if (showRing && unit.getFaction() === 'enemy') {
      this.enemyRing.showAt(unit.getPosition(this.tmpPos));
      this.allyRing.hide();
    } else if (showRing && unit.getFaction() === 'party') {
      this.allyRing.showAt(unit.getPosition(this.tmpPos));
      this.enemyRing.hide();
    } else {
      this.allyRing.hide();
      this.enemyRing.hide();
    }

    // Unidad bajo el cursor: tooltip (y, si hay que acercarse para atacar, el camino).
    if (this.hoveredUnit && unit) {
      const tooltip = this.unitTooltip(unit);
      const approach = this.attackPlan?.canAttack ? this.attackPlan.approach : null;
      if (approach) this.preview?.show(approach.plan.points, approach.budget, tooltip);
      else this.preview?.showLabelOnly(tooltip);
      return;
    }

    // Vista previa del camino completo: el tramo hasta donde llega el movimiento en claro,
    // el resto en rojo. Si no llega, la etiqueta dice cuánto se recorrerá de verdad.
    const m = this.movePlan;
    const showPath =
      (this.hoverKind === 'ground' || this.hoverKind === 'invalid') &&
      m &&
      m.allowed &&
      m.plan.reachable;
    if (showPath) {
      const inCombat = EncounterComponent.find()?.isInCombat() ?? false;
      const label = m.affordable
        ? `${m.plan.length.toFixed(1)} m`
        : `${m.walk.length.toFixed(1)} / ${m.plan.length.toFixed(1)} m`;
      this.preview?.show(m.plan.points, m.budget, inCombat ? label : null);
    } else {
      this.preview?.hide();
    }
  }

  /** "Enemy1 · 12/20 PV · Espada 100 % · 10 daño" (o el motivo por el que no se puede). */
  private unitTooltip(unit: UnitComponent): string {
    const parts = [unit.getDisplayName()];
    if (unit.getMaxHp() > 0) parts.push(`${Math.ceil(unit.getHp())}/${unit.getMaxHp()} PV`);
    const plan = this.attackPlan;
    if (this.hoverKind === 'enemy' && plan?.attack) {
      if (plan.canAttack || plan.allowed) {
        parts.push(`${plan.attack.name} ${Math.round(plan.hitChance * 100)} %`);
        parts.push(`${plan.damage} daño`);
      }
      if (!plan.canAttack && plan.reason) parts.push(REASON_TEXT[plan.reason] ?? plan.reason);
    }
    return parts.join(' · ');
  }

  private handleClick(): void {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected();
    if (this.hoverKind === 'ally' && this.hoveredUnit) {
      PartyComponent.find()?.select(this.hoveredUnit, 'world');
    } else if (this.hoverKind === 'ground') {
      if (selected) encounter?.requestMove(selected, this.hoverPoint);
      this.planCache.key = ''; // el presupuesto ha cambiado
    } else if (this.hoverKind === 'enemy' && this.hoveredUnit && selected) {
      const result = encounter?.requestAttack(selected, this.hoveredUnit, this.getArmedAttack());
      if (result?.ok) this.armedAttack = null; // como en BG3: tras atacar vuelve el de por defecto
      this.attackCache.key = '';
      this.planCache.key = '';
    }
  }

  public override dispose(): void {
    this.allyRing.destroy();
    this.enemyRing.destroy();
    this.preview?.destroy();
    if (this.lastHighlighted) setUnitHighlight(this.lastHighlighted, 0);
    Render.getInstance().getCanvas().style.cursor = 'default';
  }

  /** El puntero táctico de la escena (si hay). */
  public static find(): TacticalPointerComponent | null {
    const list = Engine.getEntities().getObjectManagerByName('tactical_pointer')?.getList();
    return (list?.[0] as TacticalPointerComponent | undefined) ?? null;
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
