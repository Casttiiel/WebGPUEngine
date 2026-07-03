import { ResourceManager } from '../../core/engine/ResourceManager';
import { Gamestate } from '../../core/engine/Gamestate';
import { Module } from './Module';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { Logger } from '../../core/debug/Logger';

export class ModuleManager {
  private allModules: Module[] = [];
  private systemModules: Module[] = [];
  private updateModules: Module[] = [];
  private renderDebugModules: Module[] = [];
  private startGamestate: string = '';
  private currentGamestate: Gamestate | null = null;
  private gamestates: Gamestate[] = [];
  private requestedGamestate: Gamestate | null = null;
  private isTransitioning: boolean = false; // Flag para indicar transición en progreso

  public async start(): Promise<void> {
    await Promise.all([this.loadConfig(), this.loadGamestates()]);

    const initialGamestate = this.getGamestate(this.startGamestate);

    // Count only modules that will actually start (not already active)
    const systemToStart = this.systemModules.filter((m) => !m.isActive());
    const gamestateToStart = initialGamestate
      ? [...initialGamestate].filter((m) => !m.isActive() && !systemToStart.includes(m))
      : [];

    LoadingStatus.setTotalModules(systemToStart.length, gamestateToStart.length);

    // Cargar módulos del sistema
    await this.startModules(this.systemModules, true);

    // Cargar gamestate inicial — reportProgress=true para el boot inicial
    if (this.startGamestate.length > 0 && initialGamestate) {
      Logger.info('MODULES', `Gamestate → ${this.startGamestate}`);
      await this.performGamestateTransition(initialGamestate, true);
      this.currentGamestate = initialGamestate;
    }
  }

  public update(dt: number): void {
    this.updateGamestate();

    // No actualizar módulos durante transición de gamestate
    // Esto previene race conditions con datos parcialmente cargados
    if (this.isTransitioning) {
      return;
    }

    for (const module of this.updateModules) {
      if (!module.isActive()) continue;
      module.update(dt);
    }
  }

  public pushDebugLines(filter?: string): void {
    for (const module of this.renderDebugModules) {
      if (!module.isActive()) continue;
      module.pushDebugLines(filter);
    }
  }

  public renderDebug(filter?: string): void {
    for (const module of this.renderDebugModules) {
      if (!module.isActive()) continue;
      module.renderDebug(filter);
    }
  }

  public registerGameModule(module: Module): void {
    this.allModules.push(module);
  }

  public registerSystemModule(module: Module): void {
    this.allModules.push(module);
    this.systemModules.push(module);
  }

  public getModule(name: string): Module | null {
    for (const module of this.allModules) {
      if (module.getName() === name) {
        return module;
      }
    }
    console.error('Module not found: ' + name);
    return null;
  }

  public async startModules(modules: Module[], reportProgress: boolean = false): Promise<void> {
    for (const module of modules) {
      if (module.isActive()) continue;
      await module.start();
      module.setActive(true);

      // Reportar progreso si está habilitado
      if (reportProgress) {
        LoadingStatus.moduleLoaded(module.getName());
      }
    }
  }

  public stopModules(modules: Module[]): void {
    for (const module of modules) {
      if (!module.isActive()) continue;
      module.stop();
      module.setActive(false);
    }
  }

  public changeToGamestate(gamestate: string): void {
    const gs = this.getGamestate(gamestate);
    if (!gs) {
      return;
    }

    this.requestedGamestate = gs;
  }

  public getGamestate(gamestate: string): Gamestate | null {
    for (const state of this.gamestates) {
      if (state.name === gamestate) {
        return state;
      }
    }

    return null;
  }

  public updateGamestate(): void {
    // Si ya estamos en transición, no hacer nada
    if (this.isTransitioning) {
      return;
    }

    if (!this.requestedGamestate) {
      return;
    }

    // Marcar que estamos en transición
    this.isTransitioning = true;

    // Ejecutar la transición de forma asíncrona sin bloquear el update
    this.performGamestateTransition(this.requestedGamestate)
      .then(() => {
        Logger.info('MODULES', `→ ${this.currentGamestate?.name}`);
      })
      .catch((error) => {
        console.error('Error during gamestate transition:', error);
        this.isTransitioning = false;
      });

    // Limpiar requestedGamestate inmediatamente para evitar múltiples transiciones
    this.requestedGamestate = null;
  }

  private async performGamestateTransition(
    newGamestate: Gamestate,
    reportProgress: boolean = false,
  ): Promise<void> {
    // PARAR SOLO LOS MÓDULOS QUE NO ESTÁN EN EL NUEVO GAMESTATE
    if (this.currentGamestate) {
      const modulesToStop: Module[] = [];

      for (const currentModule of this.currentGamestate) {
        let found = false;
        for (const requestedModule of newGamestate) {
          if (requestedModule.getName() === currentModule.getName()) {
            found = true;
            break;
          }
        }
        if (!found) {
          modulesToStop.push(currentModule);
        }
      }

      if (modulesToStop.length > 0) {
        this.stopModules(modulesToStop);
      }
    }

    // INICIAR LOS MÓDULOS QUE NO ESTABAN EN EL ANTERIOR GAMESTATE
    const modulesToStart: Module[] = [];
    for (const requestedModule of newGamestate) {
      let found = false;
      if (this.currentGamestate) {
        for (const currentModule of this.currentGamestate) {
          if (requestedModule.getName() === currentModule.getName()) {
            found = true;
            break;
          }
        }
      }
      if (!found) {
        modulesToStart.push(requestedModule);
      }
    }

    if (modulesToStart.length > 0) {
      await this.startModules(modulesToStart, reportProgress);
    }

    // Actualizar el gamestate actual
    this.currentGamestate = newGamestate;

    // Finalizar transición
    this.isTransitioning = false;
  }

  public async loadConfig(): Promise<void> {
    const url = `data/modules.json`;

    try {
      const response = await ResourceManager.fetch(url);
      const jsonData = await response.json();

      this.updateModules = [];
      this.renderDebugModules = [];

      for (const moduleName of jsonData['update']) {
        const module = this.getModule(moduleName);
        if (module) {
          this.updateModules.push(module);
        }
      }

      for (const moduleName of jsonData['render_debug']) {
        const module = this.getModule(moduleName);
        if (module) {
          this.renderDebugModules.push(module);
        }
      }
    } catch (error) {
      console.error('Error loading modules config:', error);
    }
  }

  public async loadGamestates(): Promise<void> {
    const url = `data/gamestates.json`;

    try {
      const response = await ResourceManager.fetch(url);
      const jsonData = await response.json();
      const jsonGamestates = jsonData['gamestates'];

      for (const gamestateName of Object.keys(jsonGamestates)) {
        const gamestate = new Gamestate(gamestateName);
        for (const jsonModule of jsonGamestates[gamestateName]) {
          const moduleName = typeof jsonModule === 'string' ? jsonModule : jsonModule['name'];
          const module = this.getModule(moduleName);
          if (module) {
            gamestate.push(module);
          }
        }
        this.gamestates.push(gamestate);
      }
      this.startGamestate = jsonData['start'];
    } catch (error) {
      console.error('Error loading gamestates:', error);
    }
  }

  public renderInMenu(): void {
    // Renderizar todos los módulos activos (Tweakpane + ImGui)
    for (const module of this.allModules) {
      if (!module.isActive()) continue;
      module.renderInMenu();
    }
  }

  public stop(): void {
    // Stop all modules
    this.stopModules(this.allModules);

    this.allModules = [];
    this.systemModules = [];
    this.updateModules = [];
    this.renderDebugModules = [];
    this.startGamestate = '';
    this.currentGamestate = null;
    this.gamestates = [];
    this.requestedGamestate = null;
    this.isTransitioning = false;
  }

  public isInTransition(): boolean {
    return this.isTransitioning;
  }

  public getCurrentGamestate(): string {
    return this.currentGamestate ? this.currentGamestate.name : '';
  }
}
