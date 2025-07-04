import { ModuleManager } from '../../modules/core/ModuleManager';
import { ModuleBoot } from '../../modules/game/ModuleBoot';
import { ModuleCameraMixer } from '../../modules/game/ModuleCameraMixer';
import { ModuleEntities } from '../../modules/game/ModuleEntities';
import { ModuleInput } from '../../modules/game/ModuleInput';
import { ModuleRender } from '../../modules/game/ModuleRender';
import { Render } from '../../renderer/core/pipeline/Render';
import { DebugUIManager } from '../debug/DebugUIManager';

export class Engine {
  private static initialized: boolean = false;
  private static debugControlsInitialized: boolean = false;

  private static _modules: ModuleManager;
  private static _render: ModuleRender;
  private static _entities: ModuleEntities;
  private static _camera_mixer: ModuleCameraMixer;
  private static _input: ModuleInput;
  private static _timeScale: number = 1.0;
  private static _debugUI: DebugUIManager = DebugUIManager.getInstance();

  private static idCounter = 0;
  private static nextId() {
    return ++Engine.idCounter;
  }

  public static generateDynamicId(): string {
    return Engine.nextId().toString().padStart(6, '0');
  }

  public static async start(): Promise<void> {
    if (this.initialized) {
      console.warn('Engine is already started.');
      return;
    }
    this.initialized = true;
    this.debugControlsInitialized = false; // Reset debug controls flag
    console.warn('Engine started.');
    const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
    await Render.getInstance().initialize(canvas);

    // Initialize debug UI
    this._debugUI.initialize();

    this._modules = new ModuleManager();
    this._render = new ModuleRender('render');
    this._entities = new ModuleEntities('entities');
    this._camera_mixer = new ModuleCameraMixer('camera_mixer');
    this._input = new ModuleInput('input');

    this._modules.registerSystemModule(this._render);
    this._modules.registerSystemModule(this._entities);
    this._modules.registerSystemModule(this._camera_mixer);
    this._modules.registerSystemModule(this._input);
    this._modules.registerSystemModule(new ModuleBoot('boot'));

    await this._modules.start();
  }

  public static update(dt: number): void {
    if (!this.initialized) {
      console.error('Engine is not started yet.');
      return;
    }
    this._modules.update(dt * this._timeScale);

    Engine.renderInMenu();
  }

  public static async render(): Promise<void> {
    if (!this.initialized) {
      console.error('Engine is not started yet.');
      return;
    }
    await this._render.generateFrame();
  }

  public static getModules(): ModuleManager {
    return this._modules;
  }

  public static getEntities(): ModuleEntities {
    return this._entities;
  }

  public static getInput(): ModuleInput {
    return this._input;
  }

  public static getRender(): ModuleRender {
    return this._render;
  }

  /**
   * Get the debug UI manager
   */
  public static getDebugUI(): DebugUIManager {
    return this._debugUI;
  }

  public static renderInMenu(): void {
    // Solo inicializamos los controles una vez para evitar duplicados
    if (!this.debugControlsInitialized) {
      // Control global de timeScale
      // Need to create a wrapper object since Tweakpane can't directly modify static properties
      const timeScaleWrapper = {
        get timeScale() {
          return Engine._timeScale;
        },
        set timeScale(value) {
          Engine._timeScale = value;
        },
      };

      this._debugUI.addInteractiveControl('Engine', timeScaleWrapper, 'timeScale', 'Time Scale', {
        min: 0.1,
        max: 10.0,
        step: 0.1,
      });

      this.debugControlsInitialized = true;
    }

    this._modules.renderInMenu();
  }

  /**
   * Stop and clean up engine resources
   */
  public static stop(): void {
    if (!this.initialized) {
      return;
    }

    // Clean up modules
    if (this._modules) {
      this._modules.stop();
    }

    // Clean up debug UI
    if (this._debugUI) {
      this._debugUI.dispose();
    }

    // Reset state
    this.initialized = false;
    this.debugControlsInitialized = false;

    console.warn('Engine stopped.');
  }
}
