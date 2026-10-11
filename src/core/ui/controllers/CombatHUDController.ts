import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { ImageWidget } from '../../../components/ui/widgets/ImageWidget';
import { TextWidget } from '../../../components/ui/widgets/TextWidget';
import type { Widget } from '../../../components/ui/Widget';
import {
  EncounterComponent,
  type EncounterState,
} from '../../../components/game/tactical/EncounterComponent';

const BANNER_TIME = 1.5;
const BUTTON_NORMAL = [0.35, 0.25, 0.08, 0.9] as const;
const BUTTON_HOVER = [0.55, 0.4, 0.12, 1] as const;

/**
 * CombatHUDController — HUD del combate por turnos (assets/ui/combat_hud.json):
 * ronda y turno, orden de iniciativa, recursos del turno, botón de fin de turno y
 * rótulos de estado (COMBATE / VICTORIA / DERROTA).
 * La fuente bitmap solo tiene mayúsculas y ASCII básico: sin tildes.
 */
export class CombatHUDController extends WidgetController {
  private banner: TextWidget | null = null;
  private round: TextWidget | null = null;
  private order: TextWidget | null = null;
  private resources: ImageWidget | null = null;
  private resourcesText: TextWidget | null = null;
  private endTurn: ImageWidget | null = null;
  private endTurnHovered = false;
  private resolved = false;

  private lastState: EncounterState | null = null;
  private bannerTimer = 0;

  constructor() {
    super('combat_hud_controller');
  }

  public update(dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    const encounter = EncounterComponent.find();
    if (!encounter) {
      for (const w of [this.banner, this.round, this.order, this.resources, this.endTurn])
        w?.setVisible(false);
      return;
    }

    const state = encounter.getState();
    if (state !== this.lastState) {
      this.lastState = state;
      this.showBanner(state);
    }
    this.bannerTimer -= dt;
    if (this.banner && state !== 'defeat' && this.bannerTimer <= 0) this.banner.setVisible(false);

    const inCombat = state === 'combat';
    this.round?.setVisible(inCombat);
    this.order?.setVisible(inCombat);
    this.resources?.setVisible(inCombat);
    const playerTurn = inCombat && encounter.isPlayerTurn();
    this.endTurn?.setVisible(playerTurn);
    if (!inCombat) return;

    const active = encounter.getActiveUnitName() ?? '';
    this.round?.setText(`RONDA ${encounter.getRound()} - TURNO DE ${active}`);
    this.order?.setText(
      encounter
        .getTurnOrder()
        .map((name) => (name === active ? `[${name}]` : name))
        .join('  >  '),
    );
    if (playerTurn) {
      const r = encounter.getResources();
      this.resourcesText?.setText(
        `ACCION ${r.action}    ADICIONAL ${r.bonusAction}    MOVIMIENTO ${r.movement.toFixed(1)} M`,
      );
    } else {
      this.resourcesText?.setText(`TURNO DEL ENEMIGO: ${active}`);
    }
    const c = this.endTurnHovered ? BUTTON_HOVER : BUTTON_NORMAL;
    this.endTurn?.setColor(c[0], c[1], c[2], c[3]);
  }

  private showBanner(state: EncounterState): void {
    const text = { combat: 'COMBATE', victory: 'VICTORIA', defeat: 'DERROTA', exploration: '' }[
      state
    ];
    if (!this.banner || !text) return;
    this.banner.setText(text);
    this.banner.setVisible(true);
    this.bannerTimer = BANNER_TIME;
  }

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    const get = <T extends Widget>(alias: string) =>
      (ui.getWidgetByAlias(alias) as T | undefined) ?? null;
    this.banner = get<TextWidget>('combat_banner');
    this.round = get<TextWidget>('combat_round');
    this.order = get<TextWidget>('combat_order');
    this.resources = get<ImageWidget>('combat_resources');
    this.resourcesText = get<TextWidget>('combat_resources_text');
    this.endTurn = get<ImageWidget>('end_turn_button');
    this.endTurn?.setOnMouseEnter(() => (this.endTurnHovered = true));
    this.endTurn?.setOnMouseLeave(() => (this.endTurnHovered = false));
    this.endTurn?.setOnClick(() => {
      const encounter = EncounterComponent.find();
      if (encounter?.isPlayerTurn()) encounter.endTurn();
    });
  }
}
