import { Module } from '../core/Module';
import { Time } from '../../core/engine/Time';
import { InputManager } from '../../core/input/InputManager';
import { GameAction } from '../../types/GameAction.enum';
import { Engine } from '../../core/engine/Engine';
import { MenuController } from '../../core/ui/controllers/MenuController';
import { ButtonWidget } from '../../components/ui/widgets/ButtonWidget';

export class ModuleGamePaused extends Module {
  private menuController: MenuController | null = null;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const moduleUI = Engine.getUI();
    if (!moduleUI) return false;

    moduleUI.activateWidgetClass('PAUSE_MENU');

    const btnContinue = moduleUI.getWidgetByAlias('btn_continue') as ButtonWidget | undefined;
    const btnOptions  = moduleUI.getWidgetByAlias('btn_options')  as ButtonWidget | undefined;

    if (btnContinue && btnOptions) {
      this.menuController = new MenuController();
      this.menuController.registerOption(btnContinue, () => this.onContinue());
      this.menuController.registerOption(btnOptions,  () => this.onOptions());
      moduleUI.registerController(this.menuController);
    }

    return true;
  }

  public stop(): void {
    const moduleUI = Engine.getUI();
    if (moduleUI) {
      moduleUI.deactivateWidgetClass('PAUSE_MENU');
      if (this.menuController) {
        moduleUI.unregisterController(this.menuController);
      }
    }
    this.menuController = null;
  }

  public update(_dt: number): void {
    // P also resumes (same key that triggered pause)
    if (InputManager.getInstance().isActionJustPressed(GameAction.PAUSE)) {
      this.onContinue();
    }
  }

  public renderDebug(): void {}

  private onContinue(): void {
    Time.resume();
    Engine.getModules().changeToGamestate('gs_gameplay');
  }

  private onOptions(): void {
    // Placeholder — options sub-menu to be implemented
    console.log('Options selected');
  }
}
