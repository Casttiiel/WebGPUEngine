import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import { PartyComponent } from '../../../components/game/tactical/PartyComponent';
import type { UnitComponent, UnitStatus } from '../../../components/game/tactical/UnitComponent';
import { STATUS_HELP, STATUS_NAME } from '../../../components/game/tactical/ActionText';
import { METAL_BOOST, METAL_DRAINED, METAL_ON } from './CombatHUDController';

const SLOTS = 4;
const FRAME_NORMAL = [0.07, 0.065, 0.06, 0.9] as const;
const FRAME_HOVER = [0.62, 0.64, 0.66, 1] as const;
const FRAME_SELECTED = [0.85, 0.66, 0.3, 1] as const;
const FACE_NORMAL = [0.2, 0.27, 0.34, 1] as const;
const FACE_DOWN = [0.17, 0.16, 0.15, 1] as const;
const HP_WIDTH = 96;
const HP_HEIGHT = 10;
const METAL_HEIGHT = 8;
/** Iconos de estado al lado de cada retrato. */
const STATUS_SLOTS = 3;

interface StatusSlot {
  icon: ImageWidget;
  status: UnitStatus | null;
  texture: string | null;
  hovered: boolean;
}

interface PortraitSlot {
  frame: ImageWidget;
  face: ImageWidget | null;
  name: TextWidget | null;
  hp: ImageWidget | null;
  metal: ImageWidget | null;
  statuses: StatusSlot[];
  hovered: boolean;
}

/**
 * PartyHUDController — retratos de la party (assets/ui/party_hud.json).
 * Muestra nombre, tecla, vida y Reserva de metal de cada miembro (gris si está caído) y sus
 * estados (iconos al lado, con tooltip al pasar el ratón), resalta el
 * seleccionado y el retrato bajo el cursor, y al hacer click selecciona a ese miembro (la
 * cámara lo centra y lo sigue).
 */
export class PartyHUDController extends WidgetController {
  private slots: (PortraitSlot | null)[] = [];
  private tip: TextWidget | null = null;
  private resolved = false;

  constructor() {
    super('party_hud_controller');
  }

  public update(_dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    const party = PartyComponent.find();
    const members = party?.getMembers() ?? [];
    const selected = party?.getSelected() ?? null;
    let tip: string | null = null;

    this.slots.forEach((slot, i) => {
      if (!slot) return;
      const member = members[i];
      slot.frame.setVisible(member !== undefined);
      if (!member) return;
      const unit = member.getComponent('unit') as UnitComponent | null;
      slot.name?.setText(unit?.getDisplayName() ?? member.getName());
      const color =
        member === selected ? FRAME_SELECTED : slot.hovered ? FRAME_HOVER : FRAME_NORMAL;
      slot.frame.setColor(color[0], color[1], color[2], color[3]);
      const face = unit && !unit.isAlive() ? FACE_DOWN : FACE_NORMAL;
      slot.face?.setColor(face[0], face[1], face[2], face[3]);
      const max = unit?.getMaxHp() ?? 0;
      const ratio = max > 0 ? Math.max(0, unit!.getHp() / max) : 0;
      slot.hp?.setSize(HP_WIDTH * ratio, HP_HEIGHT);
      const maxMetal = unit?.getMaxMetal() ?? 0;
      const drained = unit?.isDrained() === true;
      slot.metal?.setSize(
        maxMetal > 0 ? (HP_WIDTH * unit!.getMetal()) / maxMetal : 0,
        METAL_HEIGHT,
      );
      slot.metal?.setColor(
        ...(drained ? METAL_DRAINED : unit?.getMetalBoost() ? METAL_BOOST : METAL_ON),
      );
      const statuses = unit?.isAlive() ? unit.getStatuses() : [];
      slot.statuses.forEach((s, k) => {
        s.status = statuses[k] ?? null;
        s.icon.setVisible(s.status !== null);
        if (!s.status) return;
        const texture = `tactical/status_${s.status.id}.png`;
        if (s.texture !== texture) {
          s.icon.setTexture(texture);
          s.texture = texture;
        }
        if (s.hovered) tip = statusTip(s.status);
      });
    });
    this.tip?.setVisible(tip !== null);
    if (tip) this.tip?.setText(tip);
  }

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    const get = <T>(alias: string) => (ui.getWidgetByAlias(alias) as T | undefined) ?? null;
    for (let i = 0; i < SLOTS; i++) {
      const frame = get<ImageWidget>(`portrait_${i + 1}`);
      if (!frame) {
        this.slots.push(null);
        continue;
      }
      const slot: PortraitSlot = {
        frame,
        face: get<ImageWidget>(`portrait_${i + 1}_face`),
        name: get<TextWidget>(`portrait_${i + 1}_name`),
        hp: get<ImageWidget>(`portrait_${i + 1}_hp`),
        metal: get<ImageWidget>(`portrait_${i + 1}_metal`),
        statuses: [],
        hovered: false,
      };
      for (let k = 1; k <= STATUS_SLOTS; k++) {
        const icon = get<ImageWidget>(`portrait_${i + 1}_status_${k}`);
        if (!icon) continue;
        const status: StatusSlot = { icon, status: null, texture: null, hovered: false };
        icon.setOnMouseEnter(() => (status.hovered = true));
        icon.setOnMouseLeave(() => (status.hovered = false));
        slot.statuses.push(status);
      }
      frame.setOnMouseEnter(() => (slot.hovered = true));
      frame.setOnMouseLeave(() => (slot.hovered = false));
      frame.setOnClick(() => PartyComponent.find()?.select(i, 'portrait'));
      this.slots.push(slot);
    }
    this.tip = get<TextWidget>('party_status_tip');
  }
}

/** "Derribado: levantarse cuesta… (hasta su turno)". */
function statusTip(status: UnitStatus): string {
  const amount = status.amount ? ` +${status.amount} %` : '';
  const time = Number.isFinite(status.turns)
    ? `${status.turns} turno${status.turns > 1 ? 's' : ''}`
    : 'hasta su turno';
  return `${STATUS_NAME[status.id] ?? status.id}${amount}: ${STATUS_HELP[status.id] ?? ''} (${time})`;
}
