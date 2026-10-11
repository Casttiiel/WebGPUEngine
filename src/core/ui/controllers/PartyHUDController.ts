import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import { PartyComponent } from '../../../components/game/tactical/PartyComponent';

const SLOTS = 4;
const FRAME_NORMAL = [0.08, 0.08, 0.1, 0.85] as const;
const FRAME_HOVER = [0.55, 0.7, 0.9, 1] as const;
const FRAME_SELECTED = [1, 0.8, 0.3, 1] as const;

interface PortraitSlot {
  frame: ImageWidget;
  name: TextWidget | null;
  hovered: boolean;
}

/**
 * PartyHUDController — retratos de la party (assets/ui/party_hud.json).
 * Muestra nombre y tecla de cada miembro, resalta el seleccionado y el retrato bajo el
 * cursor, y al hacer click selecciona a ese miembro (la cámara lo centra y lo sigue).
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
      slot.name?.setText(member.getName());
      const color =
        member === selected ? FRAME_SELECTED : slot.hovered ? FRAME_HOVER : FRAME_NORMAL;
      slot.frame.setColor(color[0], color[1], color[2], color[3]);
    });
  }

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    for (let i = 0; i < SLOTS; i++) {
      const frame = ui.getWidgetByAlias(`portrait_${i + 1}`) as ImageWidget | undefined;
      if (!frame) {
        this.slots.push(null);
        continue;
      }
      const slot: PortraitSlot = {
        frame,
        name: (ui.getWidgetByAlias(`portrait_${i + 1}_name`) as TextWidget | undefined) ?? null,
        hovered: false,
      };
      frame.setOnMouseEnter(() => (slot.hovered = true));
      frame.setOnMouseLeave(() => (slot.hovered = false));
      frame.setOnClick(() => PartyComponent.find()?.select(i, 'portrait'));
      this.slots.push(slot);
    }
  }
}
