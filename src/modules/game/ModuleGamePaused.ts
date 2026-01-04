import { Module } from '../core/Module';
import { Time } from '../../core/engine/Time';
import { InputManager } from '../../core/input/InputManager';
import { GameAction } from '../../types/GameAction.enum';
import { Engine } from '../../core/engine/Engine';

/**
 * Módulo para gestionar el estado de pausa del juego
 * Muestra el menú de pausa y detecta P para reanudar
 */
export class ModuleGamePaused extends Module {
  private isInitialized: boolean = false;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    if (!this.isInitialized) {
      this.isInitialized = true;
    }

    // Mostrar el menú de pausa (el juego ya está pausado desde GameController)
    console.log('GamePaused started - Pause menu shown');

    return true;
  }

  public stop(): void {
    // Ocultar el menú de pausa (el juego se reanudará en GameController)
    console.log('GamePaused stopped - Pause menu hidden');
  }

  public update(_dt: number): void {
    const inputManager = InputManager.getInstance();

    // Presionar P para salir del menú de pausa
    if (inputManager.isActionJustPressed(GameAction.PAUSE)) {
      console.log('P pressed - Resuming game');
      Time.resume();
      Engine.getModules().changeToGamestate('gs_gameplay');
    }
  }

  public renderDebug(): void {
    // No hay debug info específico para el menú de pausa
  }
}
