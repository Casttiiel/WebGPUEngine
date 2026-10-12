import { vec3, vec4 } from 'gl-matrix';
import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { Engine } from '../../engine/Engine';
import { Render } from '../../../renderer/core/pipeline/Render';
import { UIRenderUtils } from '../../../renderer/core/UIRenderUtils';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import type { Widget } from '../../../components/ui/Widget';
import type { Entity } from '../../ecs/Entity';
import {
  EncounterComponent,
  type EncounterEventData,
  type EncounterState,
} from '../../../components/game/tactical/EncounterComponent';
import {
  UnitComponent as UnitComponentRef,
  type UnitComponent,
} from '../../../components/game/tactical/UnitComponent';
import {
  hotbarEntries,
  hotbarTooltip,
  type HotbarEntry,
  type TooltipLine,
  type HotbarKind,
} from '../../../components/game/tactical/Hotbar';
import { TacticalPointerComponent } from '../../../components/game/tactical/TacticalPointerComponent';
import { PartyComponent } from '../../../components/game/tactical/PartyComponent';
import { TacticalCameraControllerComponent } from '../../../components/game/tactical/TacticalCameraControllerComponent';
import { wrapText } from '../textWrap';

type RGBA = readonly [number, number, number, number];

const BANNER_TIME = 1.5;
const TURN_BANNER_TIME = 1.3;
const BUTTON_NORMAL: RGBA = [0.35, 0.25, 0.08, 0.9];
const BUTTON_HOVER: RGBA = [0.55, 0.4, 0.12, 1];

const INIT_SLOTS = 12;
const INIT_WIDTH = 112;
const INIT_GAP = 8;
const FRAME_NORMAL: RGBA = [0.08, 0.08, 0.1, 0.85];
const FRAME_HOVER: RGBA = [0.55, 0.7, 0.9, 1];
const FRAME_ACTIVE: RGBA = [1, 0.8, 0.3, 1];
const FACE_PARTY: RGBA = [0.13, 0.27, 0.6, 1];
const FACE_ENEMY: RGBA = [0.6, 0.15, 0.12, 1];
const FACE_DOWN: RGBA = [0.22, 0.22, 0.22, 1];
const HP_PARTY: RGBA = [0.25, 0.8, 0.3, 1];
const HP_ENEMY: RGBA = [0.9, 0.25, 0.2, 1];

const HOTBAR_SLOTS = 7;
const HOTBAR_WIDTH = 150;
const HOTBAR_GAP = 10;
const ICON: Record<HotbarKind, RGBA> = {
  melee: [0.55, 0.2, 0.12, 1],
  ranged: [0.15, 0.4, 0.62, 1],
  jump: [0.2, 0.5, 0.3, 1],
  push: [0.6, 0.45, 0.12, 1],
  skill: [0.45, 0.22, 0.6, 1],
};
const ICON_DISABLED: RGBA = [0.2, 0.2, 0.2, 1];
/** Qué hacer con cada acción armada (tooltip mientras está armada). */
const ARMED_HINT: Record<HotbarKind, string> = {
  melee: 'elige un enemigo',
  ranged: 'elige un enemigo o un barril',
  jump: 'elige dónde aterrizar',
  push: 'elige un barril o una caja a tu lado',
  skill: 'elige un objetivo',
};

/** Tooltip de la hotbar (panel encima del hueco), en px de referencia. */
const TIP_WIDTH = 640;
const TIP_PAD = 22;
const TIP_TITLE_HEIGHT = 50;
const TIP_LINE_HEIGHT = 28;
const TIP_LINE_SIZE = 22;
const TIP_GAP = 14;
const TIP_COLOR: Record<TooltipLine['style'], RGBA> = {
  info: [0.75, 0.75, 0.8, 1],
  description: [0.92, 0.9, 0.85, 1],
  warning: [1, 0.45, 0.4, 1],
};
const HOTBAR_TOP = -130;

const ACTION_ON: RGBA = [0.3, 0.85, 0.35, 1];
const BONUS_ON: RGBA = [1, 0.6, 0.15, 1];
const PIP_OFF: RGBA = [0.25, 0.25, 0.25, 1];
const MOVE_BAR_WIDTH = 220;

const FLOAT_TIME = 1.3;
const FLOAT_RISE = 0.8; // m/s
const FLOAT_HEIGHT = 1.3; // m sobre el centro de la unidad
const FLOAT_WIDTH = 240;
const FLOAT_DAMAGE: RGBA = [1, 0.35, 0.25, 1];
const FLOAT_CRIT: RGBA = [1, 0.85, 0.2, 1];
const FLOAT_MISS: RGBA = [0.85, 0.85, 0.85, 1];
const FLOAT_HEAL: RGBA = [0.4, 1, 0.45, 1];
const FLOAT_DOWN: RGBA = [0.7, 0.7, 0.75, 1];
const FLOAT_FIRE: RGBA = [1, 0.6, 0.15, 1];
const FLOAT_FEAR: RGBA = [0.8, 0.6, 1, 1];

/** Vista previa del daño: barra de vida sobre la cabeza de quien lo recibiría. */
const DAMAGE_BARS = 6;
const DAMAGE_BAR_WIDTH = 160;
const DAMAGE_BAR_INNER = DAMAGE_BAR_WIDTH - 4;
const DAMAGE_BAR_HEIGHT = 12;
/** Altura de la barra sobre el centro de la unidad (m). */
const DAMAGE_BAR_LIFT = 1.35;
const HP_LEFT_PARTY: RGBA = [0.3, 0.75, 0.3, 1];
const HP_LEFT_ENEMY: RGBA = [0.75, 0.2, 0.18, 1];

const STATUS_ICONS = 8;
const STATUS_SIZE = 64;
/** Altura del icono de estado sobre el centro de la unidad (m): encima de la cabeza. */
const STATUS_HEIGHT = 1.2;

interface InitiativeSlot {
  frame: ImageWidget;
  face: ImageWidget | null;
  name: TextWidget | null;
  hp: ImageWidget | null;
  unit: UnitComponent | null;
  hovered: boolean;
}

interface HotbarSlot {
  frame: ImageWidget;
  icon: ImageWidget | null;
  key: TextWidget | null;
  name: TextWidget | null;
  entry: HotbarEntry | null;
  hovered: boolean;
}

interface DamageBar {
  root: ImageWidget;
  hp: ImageWidget | null;
  maybe: ImageWidget | null;
  sure: ImageWidget | null;
  text: TextWidget | null;
}

interface FloatingText {
  widget: TextWidget;
  unit: Entity | null;
  age: number;
  color: RGBA;
  /** Desplazamiento vertical extra (varios textos a la vez sobre la misma unidad). */
  stack: number;
}

/**
 * CombatHUDController — HUD del combate por turnos (assets/ui/combat_hud.json):
 *  - barra de iniciativa (arriba): retratos en orden con vida, el activo resaltado; hover
 *    resalta la unidad en el mundo y click centra la cámara en ella,
 *  - recursos del turno: acción, acción adicional y metros de movimiento,
 *  - hotbar: ataques de la unidad (teclas 1-6), deshabilitados sin recurso, con tooltip;
 *    click arma el ataque para el siguiente click en un enemigo,
 *  - botón de fin de turno, texto flotante de daño / fallo / caída sobre las unidades,
 *  - rótulos: COMBATE / VICTORIA / DERROTA, "Turno de X" y cómo reiniciar.
 */
export class CombatHUDController extends WidgetController {
  private banner: TextWidget | null = null;
  private restartHint: TextWidget | null = null;
  private round: TextWidget | null = null;
  private turnBanner: TextWidget | null = null;
  private resources: ImageWidget | null = null;
  private resAction: ImageWidget | null = null;
  private resActionLabel: TextWidget | null = null;
  private resBonus: ImageWidget | null = null;
  private resBonusLabel: TextWidget | null = null;
  private resMoveFill: ImageWidget | null = null;
  private resMoveText: TextWidget | null = null;
  private tooltip: TextWidget | null = null;
  private tip: ImageWidget | null = null;
  private tipBg: ImageWidget | null = null;
  private tipTitle: TextWidget | null = null;
  private tipLines: TextWidget[] = [];
  private endTurn: ImageWidget | null = null;
  private endTurnHovered = false;
  private initiative: InitiativeSlot[] = [];
  private hotbar: HotbarSlot[] = [];
  private floats: FloatingText[] = [];
  private freeFloats: TextWidget[] = [];
  /** Iconos de estado (miedo) sobre la cabeza de las unidades afectadas. */
  private statusIcons: ImageWidget[] = [];
  private damageBars: DamageBar[] = [];
  private resolved = false;

  private subscribed: EncounterComponent | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastState: EncounterState | null = null;
  private bannerTimer = 0;
  private turnBannerTimer = 0;

  private readonly tmpPos = vec3.create();
  private readonly tmpClip = vec4.create();

  constructor() {
    super('combat_hud_controller');
  }

  public update(dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    const encounter = EncounterComponent.find();
    this.subscribe(encounter);
    if (!encounter) {
      this.hideAll();
      return;
    }

    const state = encounter.getState();
    if (state !== this.lastState) {
      this.lastState = state;
      this.showBanner(state);
    }
    this.bannerTimer -= dt;
    if (this.banner && state !== 'defeat' && this.bannerTimer <= 0) this.banner.setVisible(false);
    this.turnBannerTimer -= dt;
    if (this.turnBannerTimer <= 0) this.turnBanner?.setVisible(false);
    this.updateRestartHint(encounter);
    this.updateFloats(dt);
    this.updateStatusIcons();
    this.updateDamagePreview();

    const inCombat = state === 'combat';
    const playerTurn = inCombat && encounter.isPlayerTurn();
    this.round?.setVisible(inCombat);
    this.resources?.setVisible(playerTurn);
    this.endTurn?.setVisible(playerTurn);
    this.updateInitiative(encounter, inCombat);
    this.updateHotbar(encounter, playerTurn, state === 'exploration');
    if (!inCombat) return;

    this.round?.setText(`Ronda ${encounter.getRound()}`);
    if (playerTurn) this.updateResources(encounter);
    const c = this.endTurnHovered ? BUTTON_HOVER : BUTTON_NORMAL;
    this.endTurn?.setColor(c[0], c[1], c[2], c[3]);
  }

  // ── Eventos ──────────────────────────────────────────────────────────────

  private subscribe(encounter: EncounterComponent | null): void {
    if (encounter === this.subscribed) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribed = encounter;
    this.clearFloats();
    if (encounter) this.unsubscribe = encounter.onEvent((e, d) => this.onEncounterEvent(e, d));
  }

  private onEncounterEvent(event: string, data: EncounterEventData): void {
    const unit = data.unit ?? null;
    const name = (unit?.getComponent('unit') as UnitComponent | null)?.getDisplayName() ?? '';
    switch (event) {
      case 'turn':
        if (this.turnBanner && unit) {
          this.turnBanner.setText(`Turno de ${name}`);
          this.turnBanner.setVisible(true);
          this.turnBannerTimer = TURN_BANNER_TIME;
        }
        break;
      case 'damage': {
        const amount = `-${Math.round(data.amount ?? 0)}`;
        if (!data.hit) this.spawnFloat(unit, 'Fallo', FLOAT_MISS);
        else if (data.cause === 'fire') this.spawnFloat(unit, `${amount} fuego`, FLOAT_FIRE);
        else if (data.crit) this.spawnFloat(unit, `¡Crítico! ${amount}`, FLOAT_CRIT);
        else this.spawnFloat(unit, amount, FLOAT_DAMAGE);
        break;
      }
      case 'status':
        if (data.status === 'fear') this.spawnFloat(unit, '¡Miedo!', FLOAT_FEAR, 1.5);
        break;
      case 'explosion':
        this.spawnFloat(unit, '¡BUM!', FLOAT_FIRE);
        break;
      case 'downed':
        this.spawnFloat(unit, 'Caído', FLOAT_DOWN);
        break;
      case 'death':
        this.spawnFloat(unit, 'Muerto', FLOAT_DOWN);
        break;
      case 'heal':
        if ((data.amount ?? 0) > 0)
          this.spawnFloat(unit, `+${Math.round(data.amount ?? 0)}`, FLOAT_HEAL);
        break;
      case 'revive':
        this.spawnFloat(unit, 'En pie', FLOAT_HEAL);
        break;
      case 'restart':
        this.clearFloats();
        break;
    }
  }

  // ── Rótulos ──────────────────────────────────────────────────────────────

  private showBanner(state: EncounterState): void {
    const text = { combat: 'COMBATE', victory: 'VICTORIA', defeat: 'DERROTA', exploration: '' }[
      state
    ];
    if (!this.banner) return;
    if (!text) {
      this.banner.setVisible(false);
      return;
    }
    this.banner.setText(text);
    this.banner.setVisible(true);
    this.bannerTimer = BANNER_TIME;
    this.turnBanner?.setVisible(false);
  }

  private updateRestartHint(encounter: EncounterComponent): void {
    if (!this.restartHint) return;
    const show = encounter.canRestart();
    this.restartHint.setVisible(show);
    if (show) {
      this.restartHint.setText(
        encounter.getState() === 'defeat'
          ? 'Pulsa R para reiniciar'
          : 'Zona despejada · R para reiniciar',
      );
    }
  }

  // ── Barra de iniciativa ──────────────────────────────────────────────────

  private updateInitiative(encounter: EncounterComponent, inCombat: boolean): void {
    const units = inCombat ? encounter.getCombatantUnits().slice(0, INIT_SLOTS) : [];
    const active = encounter.getActiveUnit();
    const total = units.length * INIT_WIDTH + Math.max(0, units.length - 1) * INIT_GAP;
    let hovered: Entity | null = null;

    this.initiative.forEach((slot, i) => {
      const unit = units[i] ?? null;
      slot.unit = unit;
      slot.frame.setVisible(unit !== null);
      if (!unit) {
        slot.hovered = false;
        return;
      }
      slot.frame.setPosition(-total / 2 + i * (INIT_WIDTH + INIT_GAP), slot.frame.getY());
      const entity = unit.getOwner();
      if (slot.hovered) hovered = entity;

      const frame = entity === active ? FRAME_ACTIVE : slot.hovered ? FRAME_HOVER : FRAME_NORMAL;
      slot.frame.setColor(...frame);
      const face = !unit.isAlive()
        ? FACE_DOWN
        : unit.getFaction() === 'enemy'
          ? FACE_ENEMY
          : FACE_PARTY;
      slot.face?.setColor(...face);
      slot.name?.setText(unit.getDisplayName());
      const ratio = unit.getMaxHp() > 0 ? Math.max(0, unit.getHp() / unit.getMaxHp()) : 0;
      slot.hp?.setSize(104 * ratio, 14);
      const hp = unit.getFaction() === 'enemy' ? HP_ENEMY : HP_PARTY;
      slot.hp?.setColor(...hp);
    });

    TacticalPointerComponent.find()?.setUiHoverUnit(hovered);
  }

  // ── Recursos y hotbar ────────────────────────────────────────────────────

  private updateResources(encounter: EncounterComponent): void {
    const r = encounter.getResources();
    const unit = encounter.getActiveUnit()?.getComponent('unit') as UnitComponent | null;
    this.resAction?.setColor(...(r.action > 0 ? ACTION_ON : PIP_OFF));
    this.resActionLabel?.setText('Acción');
    this.resBonus?.setColor(...(r.bonusAction > 0 ? BONUS_ON : PIP_OFF));
    this.resBonusLabel?.setText('Adicional');
    const max = unit?.getMovement() ?? 9;
    this.resMoveFill?.setSize(MOVE_BAR_WIDTH * Math.min(1, r.movement / max), 16);
    this.resMoveText?.setText(`${r.movement.toFixed(1)} m`);
  }

  /**
   * En combate: los ataques de la unidad activa (teclas 1-6). En exploración: los del
   * seleccionado, para poder atacar primero (sin teclas: 1-4 seleccionan la party).
   */
  private updateHotbar(
    encounter: EncounterComponent,
    playerTurn: boolean,
    exploring: boolean,
  ): void {
    const owner = playerTurn
      ? encounter.getActiveUnit()
      : exploring
        ? (PartyComponent.find()?.getSelected() ?? null)
        : null;
    const unit = owner?.getComponent('unit') as UnitComponent | null | undefined;
    const entries = unit?.isAlive() ? hotbarEntries(unit).slice(0, HOTBAR_SLOTS) : [];
    const pointer = TacticalPointerComponent.find();
    const armed = pointer?.getArmedAttack() ?? null;
    const resources = exploring
      ? { action: 1, bonusAction: 1, movement: Infinity }
      : encounter.getResources();
    const total = entries.length * HOTBAR_WIDTH + Math.max(0, entries.length - 1) * HOTBAR_GAP;
    let tooltip: string | null = null;
    let hovered: { entry: HotbarEntry; x: number; enabled: boolean; cooldown: number } | null =
      null;

    this.hotbar.forEach((slot, i) => {
      const entry = entries[i] ?? null;
      slot.entry = entry;
      slot.frame.setVisible(entry !== null);
      if (!entry) {
        slot.hovered = false;
        return;
      }
      const x = -total / 2 + i * (HOTBAR_WIDTH + HOTBAR_GAP);
      slot.frame.setPosition(x, slot.frame.getY());
      const cooldown = exploring || !unit ? 0 : unit.getCooldown(entry.id);
      const enabled = resources[entry.cost] > 0.05 && cooldown === 0;
      const frame =
        entry.id === armed ? FRAME_ACTIVE : slot.hovered && enabled ? FRAME_HOVER : FRAME_NORMAL;
      slot.frame.setColor(...frame);
      slot.icon?.setColor(...(enabled ? ICON[entry.kind] : ICON_DISABLED));
      slot.key?.setText(exploring ? '' : String(i + 1));
      slot.name?.setText(cooldown > 0 ? `${cooldown} turno${cooldown > 1 ? 's' : ''}` : entry.name);
      slot.name?.setColor(1, 1, 1, enabled ? 1 : 0.45);
      if (slot.hovered) hovered = { entry, x, enabled, cooldown };
    });
    this.showTip(hovered);

    const armedEntry = entries.find((e) => e.id === armed);
    if (!hovered && armedEntry) {
      const target = armedEntry.skill?.target;
      const hint =
        target === 'point'
          ? 'elige dónde'
          : target === 'cone'
            ? 'elige la dirección'
            : ARMED_HINT[armedEntry.kind];
      tooltip = `${armedEntry.name}: ${hint} (Esc para cancelar)`;
    }
    this.tooltip?.setVisible(tooltip !== null);
    if (tooltip) this.tooltip?.setText(tooltip);
  }

  /** Panel con el nombre, el coste, qué hace y la descripción, encima del hueco. */
  private showTip(
    hovered: { entry: HotbarEntry; x: number; enabled: boolean; cooldown: number } | null,
  ): void {
    if (!this.tip) return;
    if (!hovered) {
      this.tip.setVisible(false);
      return;
    }
    const { title, lines } = hotbarTooltip(hovered.entry, hovered.enabled, hovered.cooldown);
    this.tipTitle?.setText(title);
    let index = 0;
    for (const line of lines) {
      for (const text of wrapText(line.text, TIP_LINE_SIZE, TIP_WIDTH - 2 * TIP_PAD)) {
        const widget = this.tipLines[index];
        if (!widget) break;
        widget.setText(text);
        widget.setColor(...TIP_COLOR[line.style]);
        widget.setPosition(TIP_PAD, TIP_TITLE_HEIGHT + index * TIP_LINE_HEIGHT);
        widget.setVisible(true);
        index++;
      }
    }
    for (let i = index; i < this.tipLines.length; i++) this.tipLines[i]!.setVisible(false);

    const height = TIP_TITLE_HEIGHT + index * TIP_LINE_HEIGHT + TIP_PAD;
    this.tip.setSize(TIP_WIDTH, height);
    this.tipBg?.setSize(TIP_WIDTH - 6, height - 6);
    // Centrado sobre el hueco, sin salirse de la pantalla (ancla abajo-centro).
    const half = UIRenderUtils.REFERENCE_WIDTH / 2;
    const x = Math.min(
      Math.max(hovered.x + HOTBAR_WIDTH / 2 - TIP_WIDTH / 2, -half + 10),
      half - TIP_WIDTH - 10,
    );
    this.tip.setPosition(x, HOTBAR_TOP - TIP_GAP - height);
    this.tip.setVisible(true);
  }

  // ── Texto flotante ───────────────────────────────────────────────────────

  /** `lift`: escalones extra hacia arriba (p.ej. para no tapar el icono de estado). */
  private spawnFloat(unit: Entity | null, text: string, color: RGBA, lift = 0): void {
    if (!unit) return;
    let widget = this.freeFloats.pop();
    if (!widget) {
      // Sin huecos: se reutiliza el más antiguo.
      const oldest = this.floats.shift();
      if (!oldest) return;
      widget = oldest.widget;
    }
    const stack = this.floats.filter((f) => f.unit === unit && f.age < 0.4).length + lift;
    widget.setText(text);
    widget.setColor(...color);
    this.floats.push({ widget, unit, age: 0, color, stack });
    this.placeFloat(this.floats[this.floats.length - 1]!);
  }

  private updateFloats(dt: number): void {
    this.floats = this.floats.filter((f) => {
      f.age += dt;
      if (f.age >= FLOAT_TIME) {
        f.widget.setVisible(false);
        this.freeFloats.push(f.widget);
        return false;
      }
      this.placeFloat(f);
      return true;
    });
  }

  private placeFloat(f: FloatingText): void {
    const unit = f.unit?.getComponent('unit') as UnitComponent | null;
    if (!unit) {
      f.widget.setVisible(false);
      return;
    }
    const p = unit.getPosition(this.tmpPos);
    p[1] = p[1]! + FLOAT_HEIGHT + f.stack * 0.35 + f.age * FLOAT_RISE;
    const screen = this.worldToUI(p);
    if (!screen) {
      f.widget.setVisible(false);
      return;
    }
    f.widget.setPosition(screen[0] - FLOAT_WIDTH / 2, screen[1] - 24);
    const fade = Math.min(1, Math.max(0, (FLOAT_TIME - f.age) / (FLOAT_TIME * 0.4)));
    f.widget.setColor(f.color[0], f.color[1], f.color[2], f.color[3] * fade);
    f.widget.setVisible(true);
  }

  /**
   * Al apuntar un ataque o una habilidad: sobre cada unidad que recibiría daño, su barra de
   * vida con la parte que perdería seguro (daño mínimo, sólida), la que podría perder (hasta
   * el máximo, translúcida) y el rango, avisando si muere o puede morir. Sin crítico.
   */
  private updateDamagePreview(): void {
    const preview = this.subscribed
      ? (TacticalPointerComponent.find()?.getDamagePreview() ?? [])
      : [];
    this.damageBars.forEach((bar, i) => {
      const entry = preview[i];
      const max = entry?.unit.getMaxHp() ?? 0;
      if (!entry || max <= 0) {
        bar.root.setVisible(false);
        return;
      }
      const p = entry.unit.getPosition(this.tmpPos);
      p[1] = p[1]! + DAMAGE_BAR_LIFT;
      const screen = this.worldToUI(p);
      if (!screen) {
        bar.root.setVisible(false);
        return;
      }
      const hp = Math.max(0, entry.unit.getHp());
      const afterMin = Math.max(0, hp - entry.min);
      const afterMax = Math.max(0, hp - entry.max);
      const px = (v: number) => (DAMAGE_BAR_INNER * v) / max;
      const left = entry.unit.getFaction() === 'party' ? HP_LEFT_PARTY : HP_LEFT_ENEMY;
      bar.hp?.setColor(...left);
      bar.hp?.setSize(px(afterMax), DAMAGE_BAR_HEIGHT);
      bar.maybe?.setPosition(2 + px(afterMax), 2);
      bar.maybe?.setSize(px(afterMin - afterMax), DAMAGE_BAR_HEIGHT);
      bar.sure?.setPosition(2 + px(afterMin), 2);
      bar.sure?.setSize(px(hp - afterMin), DAMAGE_BAR_HEIGHT);
      const range = entry.min === entry.max ? `${entry.min}` : `${entry.min}~${entry.max}`;
      const fate = entry.min >= hp ? ' · muere' : entry.max >= hp ? ' · puede morir' : '';
      bar.text?.setText(`${range} daño${fate}`);
      bar.root.setPosition(screen[0] - DAMAGE_BAR_WIDTH / 2, screen[1]);
      bar.root.setVisible(true);
    });
  }

  /** Un icono sobre la cabeza de cada unidad viva con miedo, mientras dure. */
  private updateStatusIcons(): void {
    const feared = this.subscribed
      ? UnitComponentRef.getAll().filter((u) => u.isAlive() && u.hasStatus('fear'))
      : [];
    this.statusIcons.forEach((icon, i) => {
      const unit = feared[i];
      if (!unit) {
        icon.setVisible(false);
        return;
      }
      const p = unit.getPosition(this.tmpPos);
      p[1] = p[1]! + STATUS_HEIGHT;
      const screen = this.worldToUI(p);
      icon.setVisible(screen !== null);
      if (screen) icon.setPosition(screen[0] - STATUS_SIZE / 2, screen[1] - STATUS_SIZE / 2);
    });
  }

  private clearFloats(): void {
    for (const f of this.floats) {
      f.widget.setVisible(false);
      this.freeFloats.push(f.widget);
    }
    this.floats = [];
  }

  /** Punto del mundo → coordenadas de referencia de la UI (widget raíz sin ancla). */
  private worldToUI(p: vec3): [number, number] | null {
    const camera = Engine.getRender().getMainCamera();
    const clip = vec4.set(this.tmpClip, p[0]!, p[1]!, p[2]!, 1);
    vec4.transformMat4(clip, clip, camera.getViewProjection());
    const w = clip[3]!;
    if (w <= 1e-6) return null;
    const canvas = Render.getInstance().getCanvas();
    const px = ((clip[0]! / w) * 0.5 + 0.5) * canvas.width;
    const py = (1 - ((clip[1]! / w) * 0.5 + 0.5)) * canvas.height;
    const gs = UIRenderUtils.getGlobalScale();
    const [ox, oy] = UIRenderUtils.getCanvasOffset();
    return [(px - ox) / gs, (py - oy) / gs];
  }

  // ── Widgets ──────────────────────────────────────────────────────────────

  private hideAll(): void {
    const all: (Widget | null)[] = [
      this.banner,
      this.restartHint,
      this.round,
      this.turnBanner,
      this.resources,
      this.tooltip,
      this.tip,
      this.endTurn,
      ...this.initiative.map((s) => s.frame),
      ...this.hotbar.map((s) => s.frame),
      ...this.statusIcons,
      ...this.damageBars.map((b) => b.root),
    ];
    for (const w of all) w?.setVisible(false);
    this.clearFloats();
  }

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    const get = <T extends Widget>(alias: string) =>
      (ui.getWidgetByAlias(alias) as T | undefined) ?? null;
    this.banner = get<TextWidget>('combat_banner');
    this.restartHint = get<TextWidget>('restart_hint');
    this.round = get<TextWidget>('combat_round');
    this.turnBanner = get<TextWidget>('turn_banner');
    this.resources = get<ImageWidget>('combat_resources');
    this.resAction = get<ImageWidget>('res_action');
    this.resActionLabel = get<TextWidget>('res_action_label');
    this.resBonus = get<ImageWidget>('res_bonus');
    this.resBonusLabel = get<TextWidget>('res_bonus_label');
    this.resMoveFill = get<ImageWidget>('res_move_fill');
    this.resMoveText = get<TextWidget>('res_move_text');
    this.tooltip = get<TextWidget>('hotbar_tooltip');
    this.tip = get<ImageWidget>('hotbar_tip');
    this.tipBg = get<ImageWidget>('hotbar_tip_bg');
    this.tipTitle = get<TextWidget>('hotbar_tip_title');
    for (let i = 1; i <= 8; i++) {
      const line = get<TextWidget>(`hotbar_tip_line_${i}`);
      if (line) this.tipLines.push(line);
    }

    this.endTurn = get<ImageWidget>('end_turn_button');
    this.endTurn?.setOnMouseEnter(() => (this.endTurnHovered = true));
    this.endTurn?.setOnMouseLeave(() => (this.endTurnHovered = false));
    this.endTurn?.setOnClick(() => {
      const encounter = EncounterComponent.find();
      if (encounter?.isPlayerTurn()) encounter.endTurn();
    });

    for (let i = 1; i <= INIT_SLOTS; i++) {
      const frame = get<ImageWidget>(`init_${i}`);
      if (!frame) continue;
      const slot: InitiativeSlot = {
        frame,
        face: get<ImageWidget>(`init_${i}_face`),
        name: get<TextWidget>(`init_${i}_name`),
        hp: get<ImageWidget>(`init_${i}_hp`),
        unit: null,
        hovered: false,
      };
      frame.setOnMouseEnter(() => (slot.hovered = true));
      frame.setOnMouseLeave(() => (slot.hovered = false));
      frame.setOnClick(() => {
        if (slot.unit) findCamera()?.focusOn(slot.unit.getOwner(), true);
      });
      this.initiative.push(slot);
    }

    for (let i = 1; i <= HOTBAR_SLOTS; i++) {
      const frame = get<ImageWidget>(`hotbar_${i}`);
      if (!frame) continue;
      const slot: HotbarSlot = {
        frame,
        icon: get<ImageWidget>(`hotbar_${i}_icon`),
        key: get<TextWidget>(`hotbar_${i}_key`),
        name: get<TextWidget>(`hotbar_${i}_name`),
        entry: null,
        hovered: false,
      };
      frame.setOnMouseEnter(() => (slot.hovered = true));
      frame.setOnMouseLeave(() => (slot.hovered = false));
      frame.setOnClick(() => {
        if (slot.entry) TacticalPointerComponent.find()?.armAttack(slot.entry.id);
      });
      this.hotbar.push(slot);
    }

    for (let i = 1; i <= 8; i++) {
      const w = get<TextWidget>(`float_${i}`);
      if (w) this.freeFloats.push(w);
    }
    for (let i = 1; i <= DAMAGE_BARS; i++) {
      const root = get<ImageWidget>(`dmg_bar_${i}`);
      if (!root) continue;
      this.damageBars.push({
        root,
        hp: get<ImageWidget>(`dmg_bar_${i}_hp`),
        maybe: get<ImageWidget>(`dmg_bar_${i}_maybe`),
        sure: get<ImageWidget>(`dmg_bar_${i}_sure`),
        text: get<TextWidget>(`dmg_bar_${i}_text`),
      });
    }
    for (let i = 1; i <= STATUS_ICONS; i++) {
      const w = get<ImageWidget>(`status_${i}`);
      if (w) this.statusIcons.push(w);
    }
  }
}

function findCamera(): TacticalCameraControllerComponent | null {
  const list = Engine.getEntities().getObjectManagerByName('tactical_camera_controller')?.getList();
  return (list?.[0] as TacticalCameraControllerComponent | undefined) ?? null;
}
