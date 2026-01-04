import { Module } from '../core/Module';
import { InputManager } from '../../core/input/InputManager';
import { GameAction } from '../../types/GameAction.enum';
import { Engine } from '../../core/engine/Engine';
import { Time } from '../../core/engine/Time';

/**
 * Módulo que gestiona el gameplay principal
 * Detecta cuando el jugador presiona P para pausar el juego
 */
export class ModuleGameController extends Module {
  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    // Asegurarse de que el juego esté despausado al iniciar gameplay
    Time.resume();
    console.log('GameController started - Game resumed');
    return true;
  }

  public stop(): void {
    // No hay recursos que limpiar
  }

  public update(_dt: number): void {
    const inputManager = InputManager.getInstance();

    // Detectar si se presiona P para pausar
    if (inputManager.isActionJustPressed(GameAction.PAUSE)) {
      console.log('P pressed - Pausing game');
      Time.pause();
      Engine.getModules().changeToGamestate('gs_paused');
    }
  }

  public renderDebug(): void {
    // No hay debug info específico
  }
}
