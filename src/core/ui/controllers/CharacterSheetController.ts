import { vec3 } from 'gl-matrix';
import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { Engine } from '../../engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import { wrapText } from '../textWrap';
import { SmoothStepInterpolator } from '../../math/Interpolators';
import type { CameraComponent } from '../../../components/render/CameraComponent';
import type { Entity } from '../../ecs/Entity';
import { PartyComponent } from '../../../components/game/tactical/PartyComponent';
import type { UnitComponent } from '../../../components/game/tactical/UnitComponent';
import {
  COST_NAME,
  STATUS_NAME,
  attackSummary,
  fmt,
  skillMechanics,
  turns,
} from '../../../components/game/tactical/ActionText';
import { ATTRIBUTES } from '../../../components/game/tactical/Stats';
import {
  SkillCatalog,
  isMetalAction,
  type SkillDef,
} from '../../../components/game/tactical/Skills';
import { MAX_JUMP, THROW_RANGE } from '../../../components/game/tactical/EnvironmentRules';
import type { TacticalCameraControllerComponent } from '../../../components/game/tactical/TacticalCameraControllerComponent';
import type { ActionCameraComponent } from '../../../components/game/tactical/ActionCameraComponent';

type RGBA = readonly [number, number, number, number];
type LineStyle = 'header' | 'title' | 'body';

const GOLD: RGBA = [1, 0.84, 0.5, 1];
const WHITE: RGBA = [1, 1, 1, 1];
const GREY: RGBA = [0.72, 0.72, 0.78, 1];
const RED: RGBA = [1, 0.45, 0.4, 1];
/** Cada estilo de línea: tamaño de letra, alto de la línea y espacio antes (px de referencia). */
const STYLES: Record<LineStyle, { size: number; height: number; gap: number; color: RGBA }> = {
  header: { size: 24, height: 30, gap: 12, color: GOLD },
  title: { size: 26, height: 30, gap: 6, color: WHITE },
  body: { size: 20, height: 25, gap: 0, color: GREY },
};
const LINES = 40;
/** Zona del panel donde van las líneas (y en px de referencia, relativas al panel). */
const LINES_TOP = 400;
const LINES_BOTTOM = 912;
const LINE_WIDTH = 788;
const HP_WIDTH = 788;
const HP_HEIGHT = 28;

const SHEET_CAMERA = 'SheetCamera';
const GAMEPLAY_CAMERA = 'PlayerCamera';
const BLEND_TIME = 0.35;
/** Cámara de la ficha: delante del personaje, a esta distancia y altura (m). */
const CAMERA_DISTANCE = 3.9;
const CAMERA_HEIGHT = 1.35;
const LOOK_HEIGHT = 0.9;
/** Cuánto se desplaza el personaje hacia la izquierda (fracción de media pantalla). */
const SCREEN_SHIFT = 0.5;
/** Q/E: grados por segundo al girar alrededor del personaje. */
const ORBIT_SPEED = 90;
const CAMERA_SMOOTHING = 10;
const UP = vec3.fromValues(0, 1, 0);
const DEG = Math.PI / 180;

/**
 * CharacterSheetController — ficha del personaje (assets/ui/character_sheet.json), tecla C.
 *
 * A la izquierda, el propio personaje: una cámara aparte (SheetCamera) que el mixer mezcla
 * encima de la de juego, de frente al personaje seleccionado y desplazada para que quede en
 * el tercio izquierdo (Q/E giran alrededor). A la derecha, el panel: vida, los seis
 * atributos, sus derivados (movimiento, crítico, armadura, iniciativa, penetración…),
 * ataques y habilidades con los números del personaje, acciones y estados. Tab / 1-4 cambian
 * de personaje. C o Esc la cierran.
 *
 * Mientras está abierta el mundo no recibe el ratón (bloqueador a pantalla completa), la
 * cámara táctica no se mueve, no se pasa turno con Espacio y no hay planos de acción.
 */
export class CharacterSheetController extends WidgetController {
  private static open = false;

  private resolved = false;
  private blocker: ImageWidget | null = null;
  private panel: ImageWidget | null = null;
  private nameText: TextWidget | null = null;
  private roleText: TextWidget | null = null;
  private hp: ImageWidget | null = null;
  private hpText: TextWidget | null = null;
  private hint: TextWidget | null = null;
  private stats: { label: TextWidget | null; value: TextWidget | null }[] = [];
  private attributes: { label: TextWidget | null; value: TextWidget | null }[] = [];
  private lines: TextWidget[] = [];

  private shown: Entity | null = null;
  /** Pulsaciones vistas de C / Esc (la UI va después de ModuleInput: no sirve isKeyJustPressed). */
  private presses = new Map<KeyCode, number>();
  private refreshTimer = 0;
  private orbit = 0;
  private cameraPlaced = false;
  private readonly eye = vec3.create();
  private readonly look = vec3.create();
  private readonly tmpEye = vec3.create();
  private readonly tmpLook = vec3.create();

  constructor() {
    super('character_sheet_controller');
  }

  /** ¿Está abierta? (el puntero, la cámara y el encuentro dejan de leer la entrada). */
  public static isOpen(): boolean {
    return CharacterSheetController.open;
  }

  public update(dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    if (Engine.getModules().getCurrentGamestate() !== 'gs_gameplay') return;
    const input = Engine.getInput();
    const open = CharacterSheetController.open;
    const toggle = this.pressed(KeyCode.C);
    const escape = this.pressed(KeyCode.ESCAPE);
    if (toggle && !open) this.openSheet();
    else if (open && (toggle || escape)) this.close();
    if (!CharacterSheetController.open) return;

    const selected = PartyComponent.find()?.getSelected() ?? null;
    if (!selected) {
      this.close();
      return;
    }
    // Otro personaje (Tab / 1-4): la cámara va hacia él; el texto se refresca a menudo
    // (vida, cooldowns y estados cambian en combate).
    this.refreshTimer -= dt;
    if (selected !== this.shown || this.refreshTimer <= 0) {
      this.shown = selected;
      this.refreshTimer = 0.25;
      this.fill(selected.getComponent('unit') as UnitComponent);
    }
    if (input.isKeyPressed(KeyCode.Q)) this.orbit += ORBIT_SPEED * dt;
    if (input.isKeyPressed(KeyCode.E)) this.orbit -= ORBIT_SPEED * dt;
    this.updateCamera(selected.getComponent('unit') as UnitComponent, dt);
  }

  /** ¿Se ha pulsado desde el último frame? */
  private pressed(key: KeyCode): boolean {
    const count = Engine.getInput().getKeyPressCount(key);
    const seen = this.presses.get(key);
    this.presses.set(key, count);
    return seen !== undefined && count > seen;
  }

  // ── Abrir / cerrar ───────────────────────────────────────────────────────

  private openSheet(): void {
    const selected = PartyComponent.find()?.getSelected() ?? null;
    const sheetCamera = Engine.getEntities().getEntityByName(SHEET_CAMERA);
    if (!selected || !sheetCamera || !this.panel) return;
    CharacterSheetController.open = true;
    this.blocker?.setVisible(true);
    this.panel.setVisible(true);
    // Por encima del HUD (hotbar, retratos): ni se ven encima del panel ni reciben clicks.
    ModuleUI.getInstance()?.bringWidgetClassToFront('CHARACTER_SHEET');
    this.shown = null;
    this.orbit = 0;
    this.cameraPlaced = false;
    this.findComponent<TacticalCameraControllerComponent>('tactical_camera_controller')?.setActive(
      false,
    );
    this.findComponent<ActionCameraComponent>('action_camera')?.end();
    this.updateCamera(selected.getComponent('unit') as UnitComponent, 0);
    Engine.getCameraMixer().blendCamera(sheetCamera, BLEND_TIME, new SmoothStepInterpolator());
  }

  private close(): void {
    if (!CharacterSheetController.open) return;
    CharacterSheetController.open = false;
    this.blocker?.setVisible(false);
    this.panel?.setVisible(false);
    this.findComponent<TacticalCameraControllerComponent>('tactical_camera_controller')?.setActive(
      true,
    );
    const gameplay = Engine.getEntities().getEntityByName(GAMEPLAY_CAMERA);
    if (gameplay) {
      Engine.getCameraMixer().blendCamera(gameplay, BLEND_TIME, new SmoothStepInterpolator());
    }
  }

  // ── Cámara ───────────────────────────────────────────────────────────────

  /** De frente al personaje y con él desplazado a la izquierda (el panel ocupa la derecha). */
  private updateCamera(unit: UnitComponent, dt: number): void {
    const entity = Engine.getEntities().getEntityByName(SHEET_CAMERA);
    const component = entity?.getComponent('camera') as CameraComponent | null | undefined;
    if (!component) return;
    const camera = component.getCamera();

    const feet = unit.getFeetPosition(vec3.create());
    const facing = unit.getFacing(vec3.create());
    const yaw = Math.atan2(facing[0]!, facing[2]!) + this.orbit * DEG;
    vec3.set(
      this.tmpEye,
      feet[0]! + Math.sin(yaw) * CAMERA_DISTANCE,
      feet[1]! + CAMERA_HEIGHT,
      feet[2]! + Math.cos(yaw) * CAMERA_DISTANCE,
    );
    const chest = vec3.fromValues(feet[0]!, feet[1]! + LOOK_HEIGHT, feet[2]!);
    const view = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), chest, this.tmpEye));
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), view, UP));
    const halfWidth = Math.tan(camera.getFov() / 2) * camera.getAspectRatio();
    vec3.scaleAndAdd(this.tmpLook, chest, right, CAMERA_DISTANCE * halfWidth * SCREEN_SHIFT);

    if (!this.cameraPlaced) {
      vec3.copy(this.eye, this.tmpEye);
      vec3.copy(this.look, this.tmpLook);
      this.cameraPlaced = true;
    } else {
      const k = 1 - Math.exp(-CAMERA_SMOOTHING * dt);
      vec3.lerp(this.eye, this.eye, this.tmpEye, k);
      vec3.lerp(this.look, this.look, this.tmpLook, k);
    }
    camera.lookAt(this.eye, this.look, UP);
  }

  // ── Contenido ────────────────────────────────────────────────────────────

  private fill(unit: UnitComponent): void {
    this.nameText?.setText(unit.getDisplayName());
    const role = unit.getRole();
    this.roleText?.setText(role ? `${role} · Aliado` : 'Aliado');

    const max = unit.getMaxHp();
    const hp = Math.max(0, Math.ceil(unit.getHp()));
    this.hp?.setSize(max > 0 ? HP_WIDTH * Math.min(1, hp / max) : 0, HP_HEIGHT);
    this.hpText?.setText(unit.isAlive() ? `PV ${hp} / ${max}` : `Caído · PV 0 / ${max}`);

    const attributes = unit.getAttributes();
    ATTRIBUTES.forEach((id, i) => {
      this.attributes[i]?.label?.setText(id);
      this.attributes[i]?.value?.setText(unit.hasAttributes() ? String(attributes[id]) : '-');
    });

    const stats: [string, string][] = [
      ['Movimiento', `${fmt(unit.getMovement())} m`],
      ['Crítico', `${fmt(unit.getCritChance())} %`],
      ['Armadura', `${fmt(unit.getArmor())}`],
    ];
    stats.forEach(([label, value], i) => {
      this.stats[i]?.label?.setText(label);
      this.stats[i]?.value?.setText(value);
    });

    this.layout(this.describe(unit));
    this.hint?.setText('C / Esc: cerrar   ·   Tab: otro personaje   ·   Q / E: girar');
  }

  /** Las líneas de la ficha: estadísticas, ataques, habilidades, estados y acciones. */
  private describe(unit: UnitComponent): { text: string; style: LineStyle; color?: RGBA }[] {
    const out: { text: string; style: LineStyle; color?: RGBA }[] = [];
    const add = (text: string, style: LineStyle, color?: RGBA) =>
      out.push({ text, style, ...(color && { color }) });

    const iron = unit.getMaxCharges('iron');
    add(
      [
        `Iniciativa ${unit.getInitiativeBase()} + 1d4`,
        `Penetración ${unit.getPenetration()}`,
        `Próximo crítico ${fmt(unit.getNextCritChance() * 100)} %`,
        ...(unit.hasReserve() ? [`Reserva ${unit.getMetal()} / ${unit.getMaxMetal()}`] : []),
        ...(iron > 0 ? [`Mente de hierro ${unit.getCharges('iron')} / ${iron}`] : []),
        ...(unit.isMetallic() ? ['Lleva metal'] : []),
      ].join(' · '),
      'body',
    );

    add('ATAQUES', 'header');
    for (const attack of unit.getAttacks()) {
      add(attack.name, 'title');
      add(attackSummary(attack, unit), 'body');
    }

    const skills = unit
      .getSkillIds()
      .map((id) => SkillCatalog.get(id))
      // Duraluminio y recargar los tiene todo el mundo: solo en la hotbar.
      .filter((s): s is SkillDef => s !== null && !isMetalAction(s));
    if (skills.length) {
      add('HABILIDADES', 'header');
      for (const skill of skills) {
        const cooldown = unit.getCooldown(skill.id);
        add(skill.name, 'title');
        const recharge = skill.cooldown > 0 ? ` · recarga ${turns(skill.cooldown)}` : '';
        const ready = cooldown > 0 ? ` · disponible en ${turns(cooldown)}` : '';
        const metal = skill.metal > 0 ? ` · ${skill.metal} de metal` : '';
        add(
          `${COST_NAME[skill.cost]}${metal}${recharge}${ready} · ${skillMechanics(skill, unit)}`,
          'body',
        );
      }
    }

    add('ESTADOS', 'header');
    const statuses = unit.getStatuses();
    if (!statuses.length) add('Ninguno', 'body');
    for (const status of statuses) {
      const time = Number.isFinite(status.turns) ? turns(status.turns) : 'hasta su turno';
      add(`${STATUS_NAME[status.id] ?? status.id} (${time})`, 'title', RED);
    }

    const abilities = unit.getAbilities();
    if (abilities.length) {
      add('ACCIONES', 'header');
      if (abilities.includes('jump')) {
        add(`Saltar · hasta ${fmt(MAX_JUMP)} m, gasta movimiento`, 'title');
      }
      if (abilities.includes('push')) {
        add('Empujar · objeto Grande en línea recta, daño de impacto · Acción adicional', 'title');
      }
      if (abilities.includes('throw')) {
        add(
          `Lanzar · objeto Pequeño en arco hasta ${fmt(THROW_RANGE)} m, daño de impacto · Acción`,
          'title',
        );
      }
    }
    return out;
  }

  /** Coloca las líneas una debajo de otra, partiendo las largas; lo que no cabe se corta. */
  private layout(content: { text: string; style: LineStyle; color?: RGBA }[]): void {
    let y = LINES_TOP;
    let index = 0;
    let full = false;
    for (const item of content) {
      const style = STYLES[item.style];
      const wrapped = wrapText(item.text, style.size, LINE_WIDTH);
      for (let i = 0; i < wrapped.length; i++) {
        const top = y + (i === 0 && index > 0 ? style.gap : 0);
        const line = this.lines[index];
        if (!line || top + style.height > LINES_BOTTOM) {
          full = true;
          break;
        }
        const color = item.color ?? style.color;
        line.setText(wrapped[i]!);
        line.setTextSize(style.size, style.size);
        line.setSize(LINE_WIDTH, style.height);
        line.setColor(color[0], color[1], color[2], color[3]);
        line.setPosition(line.getX(), top);
        line.setVisible(true);
        y = top + style.height;
        index++;
      }
      if (full) break;
    }
    for (let i = index; i < this.lines.length; i++) this.lines[i]!.setVisible(false);
  }

  // ── Widgets ──────────────────────────────────────────────────────────────

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    const get = <T>(alias: string) => (ui.getWidgetByAlias(alias) as T | undefined) ?? null;
    this.blocker = get<ImageWidget>('sheet_blocker');
    this.panel = get<ImageWidget>('sheet_panel');
    this.nameText = get<TextWidget>('sheet_name');
    this.roleText = get<TextWidget>('sheet_role');
    this.hp = get<ImageWidget>('sheet_hp');
    this.hpText = get<TextWidget>('sheet_hp_text');
    this.hint = get<TextWidget>('sheet_hint');
    for (let i = 1; i <= 3; i++) {
      this.stats.push({
        label: get<TextWidget>(`sheet_stat_${i}_label`),
        value: get<TextWidget>(`sheet_stat_${i}_value`),
      });
    }
    for (let i = 1; i <= 6; i++) {
      this.attributes.push({
        label: get<TextWidget>(`sheet_attr_${i}_label`),
        value: get<TextWidget>(`sheet_attr_${i}_value`),
      });
    }
    for (let i = 1; i <= LINES; i++) {
      const line = get<TextWidget>(`sheet_line_${i}`);
      if (line) this.lines.push(line);
    }
    this.blocker?.setVisible(false);
    this.panel?.setVisible(false);
  }

  private findComponent<T>(manager: string): T | null {
    const list = Engine.getEntities().getObjectManagerByName(manager)?.getList();
    return (list?.[0] as T | undefined) ?? null;
  }
}
