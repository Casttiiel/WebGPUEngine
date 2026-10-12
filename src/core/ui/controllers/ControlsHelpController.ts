import { WidgetController } from '../WidgetController';
import { ModuleUI } from '../../../modules/core/ModuleUI';
import { Engine } from '../../engine/Engine';
import { KeyCode } from '../../../types/KeyCode.enum';
import type { Widget } from '../../../components/ui/Widget';
import { CharacterSheetController } from './CharacterSheetController';

/**
 * ControlsHelpController — ayuda de controles (assets/ui/controls_help.json, generado con
 * scripts/generate-controls-help-ui.mjs). Un recordatorio discreto siempre visible
 * ("H: controles") y el panel con las teclas, que H muestra u oculta. Con la ficha del
 * personaje abierta no se ve (ocupan el mismo sitio).
 */
export class ControlsHelpController extends WidgetController {
  private resolved = false;
  private hint: Widget | null = null;
  private panel: Widget | null = null;
  private open = false;
  /** Pulsaciones vistas de H (la UI va después de ModuleInput: no sirve isKeyJustPressed). */
  private presses: number | null = null;

  constructor() {
    super('controls_help_controller');
  }

  public update(_dt: number): void {
    if (!this.resolved) this.resolveWidgets();
    const count = Engine.getInput().getKeyPressCount(KeyCode.H);
    const gameplay = Engine.getModules().getCurrentGamestate() === 'gs_gameplay';
    if (gameplay && this.presses !== null && count > this.presses) this.open = !this.open;
    this.presses = count;

    const sheet = CharacterSheetController.isOpen();
    this.panel?.setVisible(this.open && !sheet);
    this.hint?.setVisible(!this.open && !sheet);
  }

  public isOpen(): boolean {
    return this.open;
  }

  private resolveWidgets(): void {
    const ui = ModuleUI.getInstance();
    if (!ui) return;
    this.resolved = true;
    this.hint = (ui.getWidgetByAlias('help_hint') as Widget | undefined) ?? null;
    this.panel = (ui.getWidgetByAlias('help_panel') as Widget | undefined) ?? null;
  }
}
