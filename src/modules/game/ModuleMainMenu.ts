// src/modules/game/ModuleMainMenu.ts
import { Module } from '../core/Module';
import { Engine } from '../../core/engine/Engine';

/**
 * ModuleMainMenu - Main menu module
 * Ported from C++ module_main_menu.cpp
 *
 * Uses declarative UI system (activateWidgetClass/deactivateWidgetClass)
 * instead of programmatic widget creation.
 */
export class ModuleMainMenu extends Module {
  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const moduleUI = Engine.getUI();
    if (!moduleUI) {
      console.error('ModuleUI not initialized');
      return false;
    }

    console.log('ModuleMainMenu: Activating main menu UI...');

    // Activate main menu widget classes (defined in assets/ui/main_menu.json)
    moduleUI.activateWidgetClass('MAIN_MENU_BACKGROUND');
    moduleUI.activateWidgetClass('MAIN_MENU_BUTTONS');

    return true;
  }

  public update(_dt: number): void {
    // Menu update logic - widgets are updated automatically by ModuleUI
  }

  public stop(): void {
    console.log('ModuleMainMenu: Deactivating main menu UI...');

    const moduleUI = Engine.getUI();
    if (!moduleUI) return;

    // Deactivate main menu widget classes
    moduleUI.deactivateWidgetClass('MAIN_MENU_BACKGROUND');
    moduleUI.deactivateWidgetClass('MAIN_MENU_BUTTONS');
  }

  public renderDebug(): void {
    // Debug rendering (if needed)
  }

  // ============================================================================
  // BUTTON CALLBACKS (for future implementation with MenuController)
  // ============================================================================

  private onOptionStart(): void {
    console.log('START button clicked');
    // Engine.getModules().changeToGamestate('gs_gameplay');
  }

  private onOptionContinue(): void {
    console.log('CONTINUE button clicked');
    // Load saved game
  }

  private onOptionExit(): void {
    console.log('EXIT button clicked');
    // Close application or return to launcher
  }
}
