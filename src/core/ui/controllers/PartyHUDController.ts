import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import { PartyComponent } from '../../../components/game/tactical/PartyComponent';
import type { UnitComponent } from '../../../components/game/tactical/UnitComponent';

const SLOTS = 4;
const FRAME_NORMAL = [0.07, 0.065, 0.06, 0.9] as const;
const FRAME_HOVER = [0.62, 0.64, 0.66, 1] as const;
const FRAME_SELECTED = [0.85, 0.66, 0.3, 1] as const;
const FACE_NORMAL = [0.2, 0.27, 0.34, 1] as const;
const FACE_DOWN = [0.17, 0.16, 0.15, 1] as const;
const HP_WIDTH = 96;
const HP_HEIGHT = 10;

interface PortraitSlot {
  frame: ImageWidget;
  face: ImageWidget | null;
  name: TextWidget | null;
  hp: ImageWidget | null;
  hovered: boolean;
}

/**
 * PartyHUDController — retratos de la party (assets/ui/party_hud.json).
 * Muestra nombre, tecla y vida de cada miembro (gris si está caído), resalta el
 * seleccionado y el retrato bajo el cursor, y al hacer click selecciona a ese miembro (la
 * cámara lo centra y lo sigue).
 */
export class PartyHUDController extends WidgetController {
  private slots: (PortraitSlot | null)[] = [];
  private resolved = false;

  constructor() {
    super('party_hud_controller');
  }

  public update(_dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    const party = PartyComponent.find();
    const members = party?.getMembers() ?? [];
    const selected = party?.getSelected() ?? null;

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
    });
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
        hovered: false,
      };
      frame.setOnMouseEnter(() => (slot.hovered = true));
      frame.setOnMouseLeave(() => (slot.hovered = false));
      frame.setOnClick(() => PartyComponent.find()?.select(i, 'portrait'));
      this.slots.push(slot);
    }
  }
}
