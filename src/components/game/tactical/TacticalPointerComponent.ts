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
import {
  EncounterComponent,
  type AttackPlan,
  type JumpPlan,
  type MovePlan,
  type PushPlan,
  type ThrowPlan,
} from './EncounterComponent';
import { PropComponent } from './PropComponent';
import { RHYTHM_ENTRY, hotbarEntries, isAbilityId, unitSkill } from './Hotbar';
import { circleOutline, coneOutline, isHostile, lineOutline, type SkillDef } from './Skills';
import type { SkillPlan, SkillTarget } from './EncounterComponent';
import { NavMesh } from '../../../ai/nav/NavMesh';
import { PathPreview } from './PathPreview';
import { AimArrow } from './AimArrow';
import { ActionCameraComponent } from './ActionCameraComponent';
import { THROW_RANGE } from './EnvironmentRules';
import { STATUS_NAME } from './ActionText';
import { Cover } from './Cover';

/** Cobertura del destino al moverse: dónde, hacia dónde tapa y de qué enemigos. */
export interface CoverPreview {
  point: vec3;
  /** Direcciones (horizontales) de sus caras de cobertura. */
  faces: vec3[];
  hiddenFrom: UnitComponent[];
}
import { finisherDamage, hitRange, skillDamage } from './CombatRules';
import { rangeText } from './Stats';
import { CharacterSheetController } from '../../../core/ui/controllers/CharacterSheetController';
import { KeyCode } from '../../../types/KeyCode.enum';

/** Daño que recibiría una unidad (la vista previa de su barra de vida). */
export interface DamagePreview {
  unit: UnitComponent;
  min: number;
  max: number;
  /** Daño si es crítico (null: no puede critar, p.ej. habilidades e impactos). */
  crit: number | null;
}

/** Qué hay bajo el cursor. */
export type HoverKind = 'none' | 'ui' | 'ally' | 'enemy' | 'neutral' | 'ground' | 'invalid';

/** Cursor mostrado para cada tipo de hover. */
export type CursorKind = 'default' | 'select' | 'move' | 'attack' | 'interact' | 'invalid';

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
  interact: 'grab',
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
  'too far to jump': 'demasiado lejos',
  'too high to jump': 'demasiado alto',
  'obstacle too high': 'obstáculo demasiado alto',
  'cannot land there': 'no se puede aterrizar ahí',
  'too close': 'demasiado cerca',
  'not enough movement': 'sin movimiento suficiente',
  'too far to push': 'hay que estar al lado',
  'push blocked': 'bloqueado',
  'too far to throw': 'demasiado lejos',
  'too high to throw': 'demasiado alto',
  'too far to pick up': 'no llega al objeto',
  'not throwable': 'no se puede lanzar',
  'not pushable': 'no se puede empujar',
  'on cooldown': 'recargando',
  'target must be an ally': 'solo aliados',
  'target must be an enemy': 'solo enemigos',
  'target is down': 'caído',
  'path blocked': 'camino bloqueado',
  'no target': 'elige un objetivo',
  frightened: 'asustado',
  drained: 'Seco',
  'not enough metal': 'sin metal suficiente',
  'no metal': 'Reserva vacía',
  'not metallic': 'no es metálico',
  immovable: 'no se le puede mover',
  'no charges': 'sin cargas',
  'too small': 'demasiado pequeño',
  'too far': 'demasiado lejos',
  'no destination': 'elige dónde cae',
  'bubble border': 'el borde de la burbuja lo desvía',
  bubble: 'no se puede salir de la burbuja',
  covered: 'a cubierto',
};

const reasonText = (reason: string | undefined): string =>
  reason ? (REASON_TEXT[reason] ?? reason) : '';

const HOTBAR_KEYS = [
  KeyCode.NUM_1,
  KeyCode.NUM_2,
  KeyCode.NUM_3,
  KeyCode.NUM_4,
  KeyCode.NUM_5,
  KeyCode.NUM_6,
  KeyCode.NUM_7,
  KeyCode.NUM_8,
  KeyCode.NUM_9,
  KeyCode.NUM_0,
];

/**
 * TacticalPointerComponent — el ratón del jugador en el mundo táctico:
 *  - picking (rayo desde el cursor contra la física) para saber qué hay debajo,
 *  - cursor contextual (seleccionar aliado / atacar enemigo / mover / no válido),
 *  - resaltado del personaje bajo el cursor + anillo de hover (azul aliado, rojo enemigo),
 *  - vista previa del camino al suelo bajo el cursor (y metros en combate),
 *  - tooltip del objetivo (vida, % de impacto, daño o por qué no se puede atacar),
 *  - click en un miembro de la party → seleccionarlo; en el suelo → moverse; en un enemigo
 *    → atacar con el ataque armado (si es cuerpo a cuerpo y no llega, se acerca y ataca);
 *    en un objeto (barril, caja) → empujarlo (acción adicional) o, con un ataque armado,
 *    atacarlo (un barril explosivo explota).
 * Acción armada (hotbar, teclas 1-8 en combate): otro ataque, Saltar (click en el suelo:
 * salta allí, gasta movimiento), Empujar / Lanzar (click en un objeto y después hacia dónde
 * empujarlo o dónde lanzarlo, viendo la trayectoria y a quién golpea; al elegir el objeto, plano
 * de cámara de apuntar, y al empujar una flecha en el suelo) o una habilidad. Con una habilidad armada se ve su
 * área y se resaltan los afectados antes de confirmar con click; las de "self" se lanzan al
 * pulsarlas. Esc o click derecho vuelven a lo de por defecto (con un objeto elegido, primero
 * lo sueltan).
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
  private jumpPlan: JumpPlan | null = null;
  private pushPlan: PushPlan | null = null;
  private throwPlan: ThrowPlan | null = null;
  /** Objeto elegido con Empujar / Lanzar armado: falta elegir hacia dónde (o adónde). */
  private heldObject: Entity | null = null;
  /** Empujar se armó al hacer click en un objeto (no desde la hotbar): al soltarlo, se desarma. */
  private autoArmed = false;
  private skillPlan: SkillPlan | null = null;
  /**
   * Empuje armado: el objetivo ya elegido (primer click). Falta apuntar hacia dónde (dentro de
   * su ángulo) y confirmar con el segundo click.
   */
  private skillHeld: Entity | null = null;
  /** Unidades resaltadas como afectadas por la habilidad armada. */
  private skillHighlights: Entity[] = [];

  private allyRing = new GroundMarker('tactical/ring_hover_ally.prefab');
  private enemyRing = new GroundMarker('tactical/ring_hover_enemy.prefab');
  private preview: PathPreview | null = null;
  private arrow: AimArrow | null = null;
  /** Objeto para el que está puesto el plano de cámara de apuntar (null: ninguno). */
  private aimShotFor: Entity | null = null;
  private movePlan: MovePlan | null = null;
  /** Adonde se movería de verdad: el punto bajo el cursor ajustado a la cobertura (snap). */
  private moveTarget = vec3.create();
  private coverPreview: CoverPreview | null = null;
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
      this.arrow = new AimArrow();
    }

    // Con la ficha del personaje abierta el puntero no actúa sobre el mundo.
    const inGameplay =
      Engine.getModules().getCurrentGamestate() === 'gs_gameplay' &&
      !CharacterSheetController.isOpen();
    if (inGameplay) this.handleHotbarInput();
    this.pickWorld(inGameplay);
    this.skillPlan = this.planArmedSkill();
    this.applyFeedback();
    this.updateArrow();
    this.syncAimCamera();

    if (inGameplay && Engine.getInput().isMouseButtonJustPressed(MouseButton.LEFT)) {
      this.handleClick();
    }
  }

  // ── API (asserts del MCP, UI, fases siguientes) ──────────────────────────

  /**
   * A quién dañaría lo que se está apuntando y entre cuánto y cuánto (con la armadura de cada
   * uno): el ataque sobre la unidad bajo el cursor (con el daño de su crítico), o la
   * habilidad armada sobre todos los afectados (aliados incluidos). Vacío si no se puede o
   * si no hace daño. La vista previa de la barra de vida.
   */
  public getDamagePreview(): DamagePreview[] {
    const skill = this.skillPlan;
    if (skill?.skill) {
      const caster = PartyComponent.find()?.getSelected()?.getComponent('unit') as
        | UnitComponent
        | null
        | undefined;
      if (!skill.canCast || !caster) return [];
      const motion = skill.motion;
      if (skill.skill.effects.some((e) => e.type === 'finisher')) {
        return skill.affected
          .filter((u) => u.isAlive())
          .map((unit) => ({
            unit,
            ...hitRange(caster, unit, finisherDamage(caster, unit).damage),
            crit: null,
          }));
      }
      if (motion?.kind === 'hurl') {
        // Lanzar: a quien golpea y lo lanzado (siempre recibe el golpe al caer).
        const out: DamagePreview[] = [];
        if (motion.hit?.isAlive()) {
          out.push({ unit: motion.hit, ...hitRange(null, motion.hit, motion.damage), crit: null });
        }
        out.push({ unit: motion.body, ...hitRange(null, motion.body, motion.damage), crit: null });
        return out;
      }
      if (motion && (motion.kind === 'push' || motion.kind === 'pull')) {
        // Contra quién choca y lo que se mueve (una unidad: también contra una pared, +50 %).
        const out: DamagePreview[] = [];
        const unitBody = !PropComponent.of(motion.body.getOwner());
        if (motion.hit?.isAlive()) {
          out.push({ unit: motion.hit, ...hitRange(null, motion.hit, motion.damage), crit: null });
        }
        if (unitBody && (motion.hit || motion.wall)) {
          const d = motion.hit ? motion.damage : Math.round(motion.damage * 1.5);
          out.push({ unit: motion.body, ...hitRange(null, motion.body, d), crit: null });
        }
        return out;
      }
      const damage = skillDamage(caster, skill.skill, skill.power);
      if (damage <= 0) return [];
      const penetration = Math.max(
        0,
        ...skill.skill.effects.map((e) => (e.type === 'damage' ? (e.penetration ?? 0) : 0)),
      );
      return skill.affected
        .filter((u) => u.isAlive())
        .map((unit) => ({ unit, ...hitRange(caster, unit, damage, penetration), crit: null }));
    }
    if (this.getArmedSkill()) return [];
    // Empujar / lanzar: quien recibe el golpe y el objeto (un barril que "muere" explota).
    const push = this.pushPlan?.canPush ? this.pushPlan : null;
    const thrown = this.throwPlan?.canThrow ? this.throwPlan : null;
    if (push || thrown) {
      const plan = (push ?? thrown)!;
      const prop = (push ? this.pushTarget() : this.heldObject)?.getComponent('unit') as
        | UnitComponent
        | null
        | undefined;
      const out: DamagePreview[] = [];
      const range = { min: plan.minDamage, max: plan.maxDamage, crit: null };
      if (plan.hit?.isAlive()) out.push({ unit: plan.hit, ...range });
      const data = prop ? PropComponent.of(prop.getOwner()) : null;
      if (prop?.isAlive() && data && (plan.hit || thrown) && range.max > 0) {
        // Si golpea a alguien y es de los que se rompen, se rompe entero; si no, recibe el
        // impacto con su propia armadura.
        const hp = Math.ceil(prop.getHp());
        const thrower = PartyComponent.find()?.getSelected()?.getComponent('unit') as
          | UnitComponent
          | null
          | undefined;
        const d = data.getImpactBase() + (thrower?.getAttribute('FUE') ?? 0);
        const own =
          plan.hit && data.breaksOnImpact() ? { min: hp, max: hp } : hitRange(null, prop, d);
        out.push({ unit: prop, ...own, crit: null });
      }
      return out;
    }
    if (this.isAimingObject()) return [];
    const target = this.hoveredUnit?.getComponent('unit') as UnitComponent | null | undefined;
    const attack = this.attackPlan;
    if (!target?.isAlive() || !attack?.canAttack || attack.maxDamage <= 0) return [];
    return [
      {
        unit: target,
        min: attack.minDamage,
        max: attack.maxDamage,
        crit: attack.critChance > 0 ? attack.critDamage : null,
      },
    ];
  }

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
    if (id === RHYTHM_ENTRY) return; // la pasiva no se arma
    // Habilidades sobre uno mismo: no hay que elegir objetivo, se lanzan ya.
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const skill = unitSkill(selected?.getComponent('unit') as UnitComponent | null, id);
    if (skill?.target === 'self' && selected) {
      EncounterComponent.find()?.requestSkill(selected, skill.id);
      this.armedAttack = null;
      return;
    }
    this.armedAttack = id === this.armedAttack ? null : id;
    this.heldObject = null;
    this.skillHeld = null;
    this.autoArmed = false;
  }

  /** Objetivo elegido con el Empuje armado (falta apuntar hacia dónde). */
  public getSkillHeld(): Entity | null {
    this.syncArmedOwner();
    return this.skillHeld;
  }

  /**
   * ¿La habilidad se apunta en dos pasos? Primero el objetivo y después hacia dónde (Empuje) o
   * dónde cae (Lanzar).
   */
  private isAimedPush(skill: SkillDef | null): boolean {
    return (
      !!skill &&
      skill.target === 'unit' &&
      skill.effects.some((e) => e.type === 'steelPush' || e.type === 'hurl')
    );
  }

  /** Con el objetivo ya elegido: el destino según lo que hay bajo el cursor. */
  private heldAim(skill: SkillDef, held: Entity): SkillTarget {
    const unit = this.hoveredUnit?.getComponent('unit') as UnitComponent | null | undefined;
    if (this.hoverKind === 'ui' || this.hoverKind === 'none') return { unit: held };
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const other = unit && unit.getOwner() !== held && unit.getOwner() !== selected ? unit : null;
    if (skill.effects.some((e) => e.type === 'hurl')) {
      // Lanzar: junto a la unidad bajo el cursor, o al punto del suelo.
      return other
        ? { unit: held, toUnit: other.getOwner() }
        : { unit: held, point: this.hoverPoint };
    }
    // Empuje: hacia donde apunta el ratón (la regla lo ajusta al ángulo).
    const from = (held.getComponent('unit') as UnitComponent).getFeetPosition(vec3.create());
    const to = other ? other.getFeetPosition(vec3.create()) : this.hoverPoint;
    const direction = vec3.fromValues(to[0]! - from[0]!, 0, to[2]! - from[2]!);
    return { unit: held, direction: vec3.length(direction) > 0.2 ? direction : null };
  }

  /**
   * Elige `entity` como el objeto de la acción armada. Al empujar, si no está al lado, anda
   * hasta él (por el lado desde el que lo alejaría); mientras, ya se apunta.
   */
  private holdObject(entity: Entity): void {
    this.heldObject = entity;
    if (this.getArmedAttack() !== 'push') return;
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected();
    if (!encounter || !selected) return;
    const plan = encounter.planPush(selected, entity);
    const walk = plan.canPush ? plan.approach?.walk.points : null;
    if (walk?.length) encounter.requestMove(selected, walk[walk.length - 1]!, false);
    this.planCache.key = '';
  }

  /** Último plan de la habilidad armada bajo el cursor (área y afectados). */
  public getSkillPlan(): SkillPlan | null {
    return this.skillPlan;
  }

  /** La habilidad armada (null si lo armado es un ataque, Saltar o Empujar). */
  private getArmedSkill(): SkillDef | null {
    const selected = PartyComponent.find()?.getSelected() ?? null;
    return unitSkill(selected?.getComponent('unit') as UnitComponent | null, this.getArmedAttack());
  }

  /** Resalta en el mundo una unidad señalada desde la UI (null: ninguna). */
  public setUiHoverUnit(unit: Entity | null): void {
    this.uiHoverUnit = unit;
  }

  /** Último plan de ataque bajo el cursor (asserts, UI). */
  public getAttackPlan(): AttackPlan | null {
    return this.attackPlan;
  }

  /** Último plan de salto bajo el cursor (con Saltar armado). */
  public getJumpPlan(): JumpPlan | null {
    return this.jumpPlan;
  }

  /** Último plan de empujar el objeto bajo el cursor. */
  public getPushPlan(): PushPlan | null {
    return this.pushPlan;
  }

  /** Último plan de lanzar el objeto elegido (con Lanzar armado). */
  public getThrowPlan(): ThrowPlan | null {
    return this.throwPlan;
  }

  /** Objeto elegido con Empujar / Lanzar armado (falta elegir hacia dónde). */
  public getHeldObject(): Entity | null {
    this.syncArmedOwner();
    return this.heldObject;
  }

  /** Empujar o Lanzar armado: los clicks eligen objeto y después dirección o destino. */
  private isAimingObject(): boolean {
    const armed = this.getArmedAttack();
    return armed === 'push' || armed === 'throw';
  }

  /** El objeto que se empujaría: el elegido o, sin Empujar armado, el que está bajo el cursor. */
  private pushTarget(): Entity | null {
    return this.isAimingObject() ? this.heldObject : this.hoveredUnit;
  }

  /** ¿Se puede elegir `entity` como objeto para la acción armada (Empujar / Lanzar)? */
  private canHold(entity: Entity | null): entity is Entity {
    const prop = entity ? PropComponent.of(entity) : null;
    const unit = entity?.getComponent('unit') as UnitComponent | null | undefined;
    if (!prop || !unit?.isAlive()) return false;
    // Lanzar: lo Pequeño; empujar a mano: lo Grande.
    return this.getArmedAttack() === 'throw' ? prop.isSmall() : !prop.isSmall();
  }

  /** El ataque armado explícitamente (null si no hay o si lo armado es Saltar / Empujar). */
  private getArmedAttackId(): string | null {
    const armed = this.getArmedAttack();
    return isAbilityId(armed) || this.getArmedSkill() ? null : armed;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /** El ataque armado es del seleccionado: al cambiar de unidad (o de turno) se desarma. */
  private syncArmedOwner(): void {
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (selected !== this.armedFor) {
      this.armedFor = selected;
      this.armedAttack = null;
      this.heldObject = null;
      this.skillHeld = null;
    }
    const target = this.skillHeld?.getComponent('unit') as UnitComponent | null | undefined;
    if (this.skillHeld && (!this.armedAttack || !target?.isAlive())) this.skillHeld = null;
    // El objeto elegido ya no está (destruido) o la acción armada ya no es Empujar / Lanzar.
    const held = this.heldObject?.getComponent('unit') as UnitComponent | null | undefined;
    const armed = this.armedAttack;
    if (this.heldObject && (!held?.isAlive() || (armed !== 'push' && armed !== 'throw'))) {
      this.heldObject = null;
    }
  }

  private handleHotbarInput(): void {
    const input = Engine.getInput();
    if (
      input.isKeyJustPressed(KeyCode.ESCAPE) ||
      input.isMouseButtonJustPressed(MouseButton.RIGHT)
    ) {
      if (this.getSkillHeld()) this.skillHeld = null;
      else if (this.getHeldObject() && !this.autoArmed) this.heldObject = null;
      else this.armAttack(null);
    }
    const encounter = EncounterComponent.find();
    if (!encounter?.isInCombat() || !encounter.isPlayerTurn()) return;
    const unit = PartyComponent.find()?.getSelected()?.getComponent('unit') as
      | UnitComponent
      | null
      | undefined;
    const entries = unit ? hotbarEntries(unit) : [];
    HOTBAR_KEYS.forEach((key, i) => {
      const entry = entries[i];
      if (entry && input.isKeyJustPressed(key)) this.armAttack(entry.id);
    });
  }

  /** Cobertura en el final del camino (si llega): caras y de qué enemigos queda a cubierto. */
  private coverAt(unit: UnitComponent, move: MovePlan): CoverPreview | null {
    const end = move.walk.points[move.walk.points.length - 1];
    if (!end) return null;
    const faces = Cover.faces(end, unit.getCapsuleRadius(), unit);
    if (!faces.length) return null;
    const hiddenFrom = UnitComponent.getAll().filter(
      (u) =>
        u.isAlive() &&
        u.getFaction() === 'enemy' &&
        Cover.coveredAt(end, unit.getCapsuleRadius(), u.getFeetPosition(vec3.create()), unit),
    );
    return { point: vec3.clone(end), faces: faces.map((f) => f.dir), hiddenFrom };
  }

  /** Cobertura del destino al mover (escudos del HUD), o null. */
  public getCoverPreview(): CoverPreview | null {
    return this.coverPreview;
  }

  private pickWorld(inGameplay: boolean): void {
    this.hoveredUnit = null;
    this.movePlan = null;
    this.coverPreview = null;
    this.attackPlan = null;
    this.jumpPlan = null;
    this.pushPlan = null;
    this.throwPlan = null;
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
      const armed = this.getArmedAttack();
      if (this.getArmedSkill()) {
        // La habilidad se planifica aparte (planArmedSkill).
      } else if (this.isAimingObject()) {
        // Con un objeto elegido, la unidad es hacia dónde empujarlo / a quién lanzarlo.
        if (this.heldObject && unit.getOwner() !== this.heldObject) {
          this.planObjectAim(unit.getFeetPosition(vec3.create()), unit.getOwner());
        }
      } else if (this.hoverKind === 'enemy' && !isAbilityId(armed)) {
        this.attackPlan = this.planAttackOn(unit.getOwner());
      } else if (this.hoverKind === 'neutral' && PropComponent.of(unit.getOwner())) {
        // Objeto: con un ataque armado se ataca; si no, se empuja.
        if (this.getArmedAttackId()) this.attackPlan = this.planAttackOn(unit.getOwner());
        else if (armed !== 'jump') this.pushPlan = this.planPushOn(unit.getOwner());
      }
      return;
    }

    vec3.scaleAndAdd(this.hoverPoint, ray.origin, ray.direction, result.hit.timeOfImpact);
    if (this.isAimingObject()) {
      if (!this.heldObject) {
        this.hoverKind = 'invalid';
        return;
      }
      this.planObjectAim(this.hoverPoint, null);
      const ok = this.getPushPlan()?.canPush || this.getThrowPlan()?.canThrow;
      this.hoverKind = ok ? 'ground' : 'invalid';
      return;
    }
    if (this.getArmedAttack() === 'jump') {
      this.jumpPlan = this.planJumpTo(this.hoverPoint);
      this.hoverKind = this.jumpPlan?.canJump ? 'ground' : 'invalid';
      return;
    }
    // Snap: cerca de una cobertura, el destino se pega a ella (GDD §5).
    const mover = PartyComponent.find()?.getSelected()?.getComponent('unit') as
      | UnitComponent
      | null
      | undefined;
    vec3.copy(
      this.moveTarget,
      mover ? Cover.snap(this.hoverPoint, mover.getCapsuleRadius(), mover) : this.hoverPoint,
    );
    this.movePlan = this.planMoveTo(this.moveTarget);
    this.coverPreview = mover && this.movePlan?.canMove ? this.coverAt(mover, this.movePlan) : null;
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

  private jumpCache = {
    point: vec3.fromValues(Infinity, 0, 0),
    key: '',
    plan: null as JumpPlan | null,
  };

  /** Plan de salto del seleccionado hasta `point` (cacheado como el de movimiento). */
  private planJumpTo(point: vec3): JumpPlan | null {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!encounter || !selected) return null;
    const key = `${selected.id}|${encounter.getState()}|${encounter.getActiveUnitName()}|${encounter.getResources().movement.toFixed(2)}|${NavMesh.getInstance().getVersion()}`;
    const c = this.jumpCache;
    if (c.key === key && vec3.squaredDistance(c.point, point) < 0.05 * 0.05) return c.plan;
    vec3.copy(c.point, point);
    c.key = key;
    c.plan = encounter.planJump(selected, point);
    return c.plan;
  }

  /** Plan de empujar `target` con el seleccionado. */
  private planPushOn(target: Entity): PushPlan | null {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!encounter || !selected) return null;
    return encounter.planPush(selected, target);
  }

  private aimCache = {
    point: vec3.fromValues(Infinity, 0, 0),
    key: '',
    push: null as PushPlan | null,
    throw: null as ThrowPlan | null,
  };

  /**
   * Con un objeto elegido: plan de empujarlo hacia `point` o de lanzarlo allí (o a `unit`).
   * Cacheado como el salto (el lanzamiento busca desde dónde lanzar).
   */
  private planObjectAim(point: vec3, unit: Entity | null): void {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const held = this.heldObject;
    if (!encounter || !selected || !held) return;
    const r = encounter.getResources();
    const key = [
      selected.id,
      held.id,
      unit?.id ?? '',
      this.getArmedAttack(),
      encounter.getState(),
      encounter.getActiveUnitName(),
      r.action,
      r.bonusAction,
      r.movement.toFixed(2),
      NavMesh.getInstance().getVersion(),
      (selected.getComponent('unit') as UnitComponent).isBusy(),
    ].join('|');
    const c = this.aimCache;
    if (c.key !== key || vec3.squaredDistance(c.point, point) > 0.05 * 0.05) {
      vec3.copy(c.point, point);
      c.key = key;
      c.push = null;
      c.throw = null;
      if (this.getArmedAttack() === 'throw') {
        c.throw = encounter.planThrow(selected, held, unit ? { unit } : { point });
      } else {
        const center = (held.getComponent('unit') as UnitComponent).getFeetPosition(vec3.create());
        const dir = vec3.fromValues(point[0]! - center[0]!, 0, point[2]! - center[2]!);
        c.push = vec3.length(dir) > 0.2 ? encounter.planPush(selected, held, dir) : null;
      }
    }
    this.pushPlan = c.push;
    this.throwPlan = c.throw;
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
      this.attackCache.plan = encounter.planAttack(selected, target, this.getArmedAttackId());
    }
    return this.attackCache.plan;
  }

  /** Plan de la habilidad armada contra lo que hay bajo el cursor (unidad o suelo). */
  private planArmedSkill(): SkillPlan | null {
    const skill = this.getArmedSkill();
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!skill || !encounter || !selected) return null;
    const unit = this.hoveredUnit?.getComponent('unit') as UnitComponent | null | undefined;
    const held = this.getSkillHeld();
    if (held) return encounter.planSkill(selected, skill.id, this.heldAim(skill, held));
    if (skill.target === 'unit') {
      return this.hoveredUnit
        ? encounter.planSkill(selected, skill.id, { unit: this.hoveredUnit })
        : null;
    }
    if (unit) return encounter.planSkill(selected, skill.id, { unit: this.hoveredUnit });
    if (this.hoverKind !== 'ground' && this.hoverKind !== 'invalid') return null;
    return encounter.planSkill(selected, skill.id, { point: this.hoverPoint });
  }

  /** Vista previa de la habilidad: contorno del área, afectados resaltados y etiqueta. */
  private showSkillPreview(plan: SkillPlan): void {
    const skill = plan.skill!;
    this.highlightAffected(plan.affected.map((u) => u.getOwner()));
    const names = plan.affected.map((u) => {
      const ally = u.getFaction() === 'party' && isHostile(skill) ? ' (aliado)' : '';
      return `${u.getDisplayName()}${ally}`;
    });
    let label = skill.name;
    const motion = plan.motion;
    if (this.isAimedPush(skill) && plan.canCast) {
      label += this.skillHeld ? ' (apunta y haz click)' : ' (click para elegir)';
    }
    if (!plan.canCast && plan.reason) label += ` · ${reasonText(plan.reason)}`;
    else if (motion?.kind === 'disarm') label += ` → desarma a ${motion.body.getDisplayName()}`;
    else if (motion?.kind === 'hurl') {
      label += ` → ${motion.body.getDisplayName()}`;
      if (motion.hit) label += ` · golpea a ${motion.hit.getDisplayName()}`;
    } else if (motion && motion.kind !== 'leap') {
      const length = vec3.distance(motion.points[0]!, motion.points[motion.points.length - 1]!);
      label += ` → ${motion.body.getDisplayName()} ${length.toFixed(1)} m`;
      if (motion.hit) label += ` · golpea a ${motion.hit.getDisplayName()}`;
      else if (motion.wall) label += ' · contra la pared';
      if (motion.kind === 'pull' && !PropComponent.of(motion.body.getOwner())) {
        label += ' · llega Derribado';
      }
    } else if (motion?.kind === 'leap') {
      const pts = motion.points;
      const from = pts[0]!;
      const to = pts[pts.length - 1]!;
      label += ` ${Math.hypot(to[0]! - from[0]!, to[2]! - from[2]!).toFixed(1)} m`;
    } else if (skill.target === 'unit' && plan.affected[0]) {
      const t = plan.affected[0];
      label += ` → ${t.getDisplayName()} ${Math.ceil(t.getHp())}/${t.getMaxHp()} PV`;
    } else if (!skill.effects.some((e) => e.type === 'teleport')) {
      label += names.length ? ` · afecta a: ${names.join(', ')}` : ' · no afecta a nadie';
    }

    const origin = plan.origin;
    let outline: vec3[] | null = null;
    if (origin && skill.target === 'cone' && plan.direction) {
      outline = coneOutline(origin, plan.direction, skill.length, skill.angle);
    } else if (origin && skill.target === 'line' && plan.direction) {
      outline = lineOutline(origin, plan.direction, plan.reach, skill.width);
    } else if ((motion?.kind === 'leap' || motion?.kind === 'hurl') && plan.canCast) {
      outline = motion.points;
    } else if (origin && skill.radius > 0) {
      outline = circleOutline(origin, skill.radius);
    } else if (origin && skill.effects.some((e) => e.type === 'teleport')) {
      const selected = PartyComponent.find()?.getSelected();
      const from = (selected?.getComponent('unit') as UnitComponent | null)?.getFeetPosition();
      if (from) outline = [from, origin];
    }
    // Si tiene que acercarse, primero el camino (solo en combate) y después el área.
    const approach = plan.canCast ? plan.approach : null;
    if (approach) label += ` · se acerca ${approach.plan.length.toFixed(1)} m`;
    const walk = approach && this.showWalkPaths() ? approach.plan.points : [];
    const points = [...walk, ...(outline ?? [])];
    if (points.length) this.preview?.show(points, Infinity, label);
    else this.preview?.showLabelOnly(label);
  }

  private highlightAffected(entities: Entity[]): void {
    for (const e of this.skillHighlights) {
      if (!entities.includes(e) && e !== this.lastHighlighted) setUnitHighlight(e, 0);
    }
    for (const e of entities) setUnitHighlight(e, this.hoverHighlight);
    this.skillHighlights = entities;
  }

  private lastHighlighted: Entity | null = null;

  private applyFeedback(): void {
    // Cursor: sobre un enemigo, atacar solo si se puede; sobre un objeto, empujar o atacar.
    let cursor = CURSOR_FOR_HOVER[this.hoverKind];
    if (this.hoverKind === 'enemy' && !this.attackPlan?.canAttack) cursor = 'invalid';
    if (this.hoverKind === 'neutral' && this.hoveredUnit && PropComponent.of(this.hoveredUnit)) {
      cursor = this.pushPlan?.canPush
        ? 'interact'
        : this.attackPlan?.canAttack
          ? 'attack'
          : 'invalid';
    }
    const skillPlan = this.skillPlan;
    if (skillPlan?.skill) {
      cursor = skillPlan.canCast ? (isHostile(skillPlan.skill) ? 'attack' : 'interact') : 'invalid';
    } else if (this.getArmedSkill()) {
      cursor = 'invalid';
    } else if (this.isAimingObject() && this.hoverKind !== 'ui' && this.hoverKind !== 'none') {
      if (!this.heldObject) {
        cursor = this.canHold(this.hoveredUnit) ? 'interact' : 'invalid';
      } else {
        const plan = this.getArmedAttack() === 'throw' ? this.throwPlan : this.pushPlan;
        const ok = this.throwPlan?.canThrow || this.pushPlan?.canPush;
        cursor = !ok ? 'invalid' : plan?.hit?.getFaction() === 'enemy' ? 'attack' : 'interact';
      }
    }
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      Render.getInstance().getCanvas().style.cursor = CURSORS[cursor];
    }

    // Resaltado del personaje bajo el cursor (o señalado desde la UI)
    const focus = this.hoveredUnit ?? (this.hoverKind === 'ui' ? this.uiHoverUnit : null);
    if (focus !== this.lastHighlighted) {
      if (this.lastHighlighted && !this.skillHighlights.includes(this.lastHighlighted)) {
        setUnitHighlight(this.lastHighlighted, 0);
      }
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

    // Habilidad armada: su área, los afectados y qué hará (o por qué no se puede).
    if (skillPlan?.skill) {
      this.showSkillPreview(skillPlan);
      return;
    }
    // Empujar / Lanzar armado: elegir objeto, y después la trayectoria y a quién golpea.
    if (this.isAimingObject()) {
      this.showObjectPreview();
      return;
    }
    this.highlightAffected([]);
    if (this.getArmedSkill()) {
      this.preview?.hide();
      return;
    }

    // Unidad bajo el cursor: tooltip (y, si hay que acercarse para atacar, el camino).
    if (this.hoveredUnit && unit) {
      const tooltip = this.unitTooltip(unit);
      // Si hay que acercarse (para atacar o, en un objeto, para empujarlo), el camino.
      const approach = this.pushPlan?.canPush
        ? this.pushPlan.approach
        : this.attackPlan?.canAttack
          ? this.attackPlan.approach
          : null;
      if (approach && this.showWalkPaths()) {
        this.preview?.show(approach.plan.points, approach.budget, tooltip);
      } else {
        this.preview?.showLabelOnly(tooltip);
      }
      return;
    }

    // Saltar armado: la trayectoria (sobre el suelo) y los metros, o por qué no se puede.
    const jump = this.jumpPlan;
    if (jump && (this.hoverKind === 'ground' || this.hoverKind === 'invalid')) {
      if (jump.canJump) {
        // Si no llega desde aquí: anda hasta el despegue y salta (los metros se suman).
        const walk = jump.approach?.plan;
        const label = walk
          ? `Saltar ${jump.distance.toFixed(1)} m (+${walk.length.toFixed(1)} m andando)`
          : `Saltar ${jump.distance.toFixed(1)} m`;
        // Fuera de combate, como al andar, sin puntos: solo la etiqueta.
        if (this.showWalkPaths()) {
          this.preview?.show([...(walk?.points ?? []), ...jump.points], Infinity, label);
        } else {
          this.preview?.showLabelOnly(label);
        }
      } else if (jump.allowed) {
        this.preview?.showLabelOnly(`Saltar: ${reasonText(jump.reason)}`);
      } else {
        this.preview?.hide();
      }
      return;
    }

    // Vista previa del camino completo: el tramo hasta donde llega el movimiento en claro,
    // el resto en rojo. Si no llega, la etiqueta dice cuánto se recorrerá de verdad.
    const m = this.movePlan;
    const showPath =
      this.showWalkPaths() &&
      (this.hoverKind === 'ground' || this.hoverKind === 'invalid') &&
      m &&
      m.allowed &&
      m.plan.reachable;
    if (showPath) {
      let label = m.affordable
        ? `${m.plan.length.toFixed(1)} m`
        : `${m.walk.length.toFixed(1)} / ${m.plan.length.toFixed(1)} m`;
      const cover = this.coverPreview;
      if (cover?.hiddenFrom.length) {
        label += ` · a cubierto de ${cover.hiddenFrom.map((u) => u.getDisplayName()).join(', ')}`;
      }
      this.preview?.show(m.plan.points, m.budget, label);
    } else {
      this.preview?.hide();
    }
  }

  /**
   * Empujar / Lanzar armado. Sin objeto: cuál se puede elegir. Con objeto: la trayectoria (recta
   * al empujar, en arco al lanzar; antes, si hay que acercarse, el camino), dónde acaba, a quién
   * golpea y cuánto (resaltado, y la barra de vida con getDamagePreview).
   */
  private showObjectPreview(): void {
    const throwing = this.getArmedAttack() === 'throw';
    const verb = throwing ? 'Lanzar' : 'Empujar';
    const held = this.heldObject;
    if (!held) {
      this.highlightAffected([]);
      const hovered = this.hoveredUnit;
      const unit = hovered?.getComponent('unit') as UnitComponent | null | undefined;
      if (!hovered || !unit || this.hoverKind === 'ally')
        this.preview?.showLabelOnly(`${verb}: elige un objeto`);
      else if (this.canHold(hovered))
        this.preview?.showLabelOnly(`${verb} ${unit.getDisplayName()}`);
      else
        this.preview?.showLabelOnly(
          `${verb}: ${reasonText(throwing ? 'not throwable' : 'not pushable')}`,
        );
      return;
    }
    const prop = held.getComponent('unit') as UnitComponent;
    const plan = throwing ? this.throwPlan : this.pushPlan;
    if (!plan) {
      this.highlightAffected([held]);
      this.preview?.showLabelOnly(
        `${verb} ${prop.getDisplayName()}: ${throwing ? 'elige dónde' : 'elige hacia dónde'}`,
      );
      return;
    }
    const ok = throwing ? this.throwPlan!.canThrow : this.pushPlan!.canPush;
    this.highlightAffected(ok && plan.hit ? [held, plan.hit.getOwner()] : [held]);
    if (!ok) {
      this.preview?.showLabelOnly(`${verb}: ${reasonText(plan.reason)}`);
      return;
    }
    let label = throwing
      ? `Lanzar ${prop.getDisplayName()}`
      : `Empujar ${this.pushPlan!.pushLength.toFixed(1)} m`;
    label += plan.hit
      ? ` · golpea a ${plan.hit.getDisplayName()} (${rangeText({ min: plan.minDamage, max: plan.maxDamage })})`
      : throwing
        ? ' · cae al suelo'
        : ' · no golpea a nadie';
    if (plan.approach) label += ` · se acerca ${plan.approach.plan.length.toFixed(1)} m`;
    const walk = plan.approach && this.showWalkPaths() ? plan.approach.plan.points : [];
    // Empujar: la trayectoria es la flecha en el suelo (updateArrow).
    const trajectory = throwing ? this.throwPlan!.points : [];
    const points = [...walk, ...trajectory];
    if (points.length) this.preview?.show(points, Infinity, label);
    else this.preview?.showLabelOnly(label);
  }

  /** Flecha de empujar: con Empujar armado y un objeto elegido, o sobre un objeto empujable. */
  private updateArrow(): void {
    const motion = this.skillPlan?.canCast ? this.skillPlan.motion : null;
    if (motion && (motion.kind === 'push' || motion.kind === 'pull') && !motion.body.isMoving()) {
      const from = motion.points[0]!;
      const to = motion.points[motion.points.length - 1]!;
      const dir = vec3.sub(vec3.create(), to, from);
      const length = vec3.length(dir);
      if (length > 0.05) {
        vec3.scale(dir, dir, 1 / length);
        const hit = !!motion.hit || motion.wall;
        this.arrow?.show(from, dir, length, motion.body.getCapsuleRadius(), hit);
        return;
      }
    }
    const push = this.pushPlan;
    const target = this.pushTarget();
    const prop = target?.getComponent('unit') as UnitComponent | null | undefined;
    const aiming = this.isAimingObject() && this.heldObject !== null;
    if (aiming && push?.canPush && push.direction && prop?.isAlive() && !prop.isMoving()) {
      const from = prop.getFeetPosition(this.tmpPos);
      this.arrow?.show(from, push.direction, push.pushLength, prop.getCapsuleRadius(), !!push.hit);
    } else {
      this.arrow?.hide();
    }
  }

  /**
   * Plano de cámara de apuntar (como el de los ataques): al elegir un objeto con Empujar o
   * Lanzar encuadra a quien lo hace, el objeto y a quién podría golpear; al soltarlo vuelve a
   * la cámara de juego (al ejecutar la acción, el plano pasa a ser el de la acción).
   */
  private syncAimCamera(): void {
    const held = this.getHeldObject();
    if (held === this.aimShotFor) return;
    const camera = ActionCameraComponent.find();
    if (this.aimShotFor) camera?.endAim();
    this.aimShotFor = held;
    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (held && selected) camera?.beginAim(selected, this.aimTargets(selected, held));
  }

  /** El objeto y las unidades que podría golpear (a tiro del empujón o del lanzamiento). */
  private aimTargets(selected: Entity, held: Entity): (Entity | vec3)[] {
    const prop = held.getComponent('unit') as UnitComponent;
    const self = selected.getComponent('unit') as UnitComponent;
    const throwing = this.getArmedAttack() === 'throw';
    const center = (throwing ? self : prop).getFeetPosition(vec3.create());
    const reach = throwing ? THROW_RANGE : 4;
    const p = vec3.create();
    const targets: (Entity | vec3)[] = [held];
    for (const u of UnitComponent.getAll()) {
      if (u === prop || u === self || !u.isAlive() || u.getFaction() !== 'enemy') continue;
      u.getFeetPosition(p);
      if (Math.hypot(p[0]! - center[0]!, p[2]! - center[2]!) <= reach) targets.push(u.getOwner());
    }
    if (targets.length === 1) {
      // Nadie a tiro: el objeto y hasta dónde llegaría alejándolo.
      const from = self.getFeetPosition(vec3.create());
      const away = vec3.fromValues(center[0]! - from[0]!, 0, center[2]! - from[2]!);
      if (vec3.length(away) > 1e-3) {
        vec3.normalize(away, away);
        targets.push(vec3.scaleAndAdd(away, prop.getFeetPosition(vec3.create()), away, reach - 1));
      }
    }
    return targets;
  }

  /** Los puntos del recorrido andando solo se ven en combate (en exploración no hacen falta). */
  private showWalkPaths(): boolean {
    return EncounterComponent.find()?.isInCombat() ?? false;
  }

  /** "Enemy1 · 12/20 PV · Espada 100 % · 10 daño · crítico 25 %" (o el motivo por el que no se puede). */
  private unitTooltip(unit: UnitComponent): string {
    const parts = [unit.getDisplayName()];
    if (unit.getMaxHp() > 0) parts.push(`${Math.ceil(unit.getHp())}/${unit.getMaxHp()} PV`);
    for (const st of unit.getStatuses()) {
      const name = (STATUS_NAME[st.id] ?? st.id).toLowerCase();
      const amount = st.amount ? ` +${st.amount} %` : '';
      const time = Number.isFinite(st.turns)
        ? ` (${st.turns} turno${st.turns > 1 ? 's' : ''})`
        : '';
      parts.push(`${name}${amount}${time}`);
    }
    if (unit.isDisarmed()) parts.push('desarmado');
    const plan = this.attackPlan;
    if (this.hoverKind === 'enemy' && plan?.attack) {
      if (plan.canAttack || plan.allowed) {
        parts.push(`${plan.attack.name} ${Math.round(plan.hitChance * 100)} %`);
        const range = rangeText({ min: plan.minDamage, max: plan.maxDamage });
        const crit = plan.critChance > 0 ? ` (crítico ${plan.critDamage})` : '';
        parts.push(`${range}${crit} daño`);
        if (plan.critChance > 0) parts.push(`crítico ${Math.round(plan.critChance * 100)} %`);
      }
      if (!plan.canAttack && plan.reason) parts.push(reasonText(plan.reason));
    } else if (this.hoverKind === 'neutral' && plan?.attack) {
      parts.push(plan.canAttack ? plan.attack.name : reasonText(plan.reason));
    } else if (this.pushPlan) {
      const push = this.pushPlan;
      parts.push(
        push.canPush
          ? 'Empujar (acción adicional) · click para apuntar'
          : `Empujar: ${reasonText(push.reason)}`,
      );
    }
    return parts.join(' · ');
  }

  private handleClick(): void {
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected();
    // Con una habilidad armada, el click la lanza (también sobre un aliado: curar).
    const skill = this.getArmedSkill();
    if (skill && this.isAimedPush(skill)) {
      // Empuje: el primer click elige el objetivo; el segundo empuja hacia donde apunta.
      const plan = this.skillPlan;
      if (!selected || !plan?.canCast) return;
      if (!this.skillHeld) {
        this.skillHeld = this.hoveredUnit;
        return;
      }
      if (!plan.motion) return;
      const result = encounter?.requestSkill(
        selected,
        skill.id,
        this.heldAim(skill, this.skillHeld),
      );
      if (result?.ok) this.armAttack(null);
      this.planCache.key = '';
      return;
    }
    if (skill) {
      const plan = this.skillPlan;
      if (selected && plan?.canCast) {
        const target =
          skill.target === 'unit' || this.hoveredUnit
            ? { unit: this.hoveredUnit }
            : { point: this.hoverPoint };
        const result = encounter?.requestSkill(selected, skill.id, target);
        if (result?.ok) this.armedAttack = null;
        this.planCache.key = '';
      }
      return;
    }
    if (this.isAimingObject()) {
      this.handleObjectClick();
      return;
    }
    if (this.hoverKind === 'ally' && this.hoveredUnit) {
      PartyComponent.find()?.select(this.hoveredUnit, 'world');
    } else if (this.hoverKind === 'ground' && this.getArmedAttack() === 'jump') {
      const result = selected ? encounter?.requestJump(selected, this.hoverPoint) : null;
      if (result?.ok) this.armedAttack = null;
      this.jumpCache.key = '';
      this.planCache.key = '';
    } else if (this.hoverKind === 'ground') {
      if (selected) encounter?.requestMove(selected, this.moveTarget);
      this.planCache.key = ''; // el presupuesto ha cambiado
    } else if (this.hoverKind === 'enemy' && this.hoveredUnit && selected) {
      const result = encounter?.requestAttack(selected, this.hoveredUnit, this.getArmedAttack());
      if (result?.ok) this.armedAttack = null; // como en BG3: tras atacar vuelve el de por defecto
      this.attackCache.key = '';
      this.planCache.key = '';
    } else if (this.hoverKind === 'neutral' && this.hoveredUnit && selected) {
      if (this.attackPlan?.canAttack) {
        const r = encounter?.requestAttack(selected, this.hoveredUnit, this.getArmedAttackId());
        if (r?.ok) this.armedAttack = null;
      } else if (this.pushPlan?.canPush) {
        // Primer paso: se acerca a la caja, entra la cámara y sale la flecha; el segundo
        // click (hacia dónde) la empuja.
        this.armedAttack = 'push';
        this.autoArmed = true;
        this.holdObject(this.hoveredUnit);
      }
      this.attackCache.key = '';
      this.planCache.key = '';
    }
  }

  /** Empujar / Lanzar armado: el primer click elige el objeto; el segundo, hacia dónde. */
  private handleObjectClick(): void {
    if (this.hoverKind === 'ui' || this.hoverKind === 'none') return;
    const encounter = EncounterComponent.find();
    const selected = PartyComponent.find()?.getSelected();
    if (!this.heldObject) {
      if (this.canHold(this.hoveredUnit)) this.holdObject(this.hoveredUnit);
      return;
    }
    if (!encounter || !selected) return;
    const held = this.heldObject;
    let ok = false;
    if (this.throwPlan?.canThrow) {
      const aim = this.hoveredUnit ? { unit: this.hoveredUnit } : { point: this.hoverPoint };
      ok = encounter.requestThrow(selected, held, aim).ok;
    } else if (this.pushPlan?.canPush && this.pushPlan.direction) {
      ok = encounter.requestPush(selected, held, this.pushPlan.direction).ok;
    }
    if (ok) {
      this.armedAttack = null;
      this.heldObject = null;
      this.autoArmed = false;
    }
    this.aimCache.key = '';
    this.planCache.key = '';
  }

  public override dispose(): void {
    this.allyRing.destroy();
    this.enemyRing.destroy();
    this.preview?.destroy();
    this.arrow?.destroy();
    if (this.aimShotFor) ActionCameraComponent.find()?.endAim();
    if (this.lastHighlighted) setUnitHighlight(this.lastHighlighted, 0);
    for (const e of this.skillHighlights) setUnitHighlight(e, 0);
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
