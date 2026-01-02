import { ModuleManager } from '../../modules/core/ModuleManager';
import { ModuleBoot } from '../../modules/game/ModuleBoot';
import { ModuleCameraMixer } from '../../modules/game/ModuleCameraMixer';
import { ModuleEntities } from '../../modules/game/ModuleEntities';
import { ModuleEnvironmentManager } from '../../modules/game/ModuleEnvironmentManager';
import { ModuleInput } from '../../modules/game/ModuleInput';
import { ModulePhysics } from '../../modules/game/ModulePhysics';
import { ModuleRender } from '../../modules/game/ModuleRender';
import { ModuleSound } from '../../modules/game/ModuleSound';
import { Render } from '../../renderer/core/pipeline/Render';
import { DebugUIManager } from '../debug/DebugUIManager';
import { LoadingStatus } from './LoadingStatus';
import { QualitySettings } from './QualitySettings';
import { ResourceManager } from './ResourceManager';

export class Engine {
  private static initialized: boolean = false;
  private static debugControlsInitialized: boolean = false;
  private static isRestarting: boolean = false;

  private static _modules: ModuleManager;
  private static _render: ModuleRender;
  private static _entities: ModuleEntities;
  private static _camera_mixer: ModuleCameraMixer;
  private static _sound: ModuleSound;
  private static _input: ModuleInput;
  private static _physics: ModulePhysics;
  private static _environment_manager: ModuleEnvironmentManager;
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
    this.debugControlsInitialized = false;
    console.warn('Engine started.');

    // WebGPU Initialization: 0% -> 25%
    LoadingStatus.updateStatus('Initializing WebGPU...', 0);
    const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
    await Render.getInstance().initialize(canvas);
    LoadingStatus.updateStatus('WebGPU initialized', 25);

    // Initialize debug UI
    //this._debugUI.initialize();

    // Module Creation: 25% -> 30%
    LoadingStatus.updateStatus('Creating module manager...', 30);
    this._modules = new ModuleManager();

    // Module Registration: 30% -> 35%
    LoadingStatus.updateStatus('Registering system modules...', 35);
    this._environment_manager = new ModuleEnvironmentManager('environment_manager');
    this._render = new ModuleRender('render');
    this._entities = new ModuleEntities('entities');
    this._camera_mixer = new ModuleCameraMixer('camera_mixer');
    this._input = new ModuleInput('input');
    this._sound = new ModuleSound('sound');
    this._physics = new ModulePhysics('physics');

    this._modules.registerSystemModule(this._environment_manager);
    this._modules.registerSystemModule(this._render);
    this._modules.registerSystemModule(this._entities);
    this._modules.registerSystemModule(this._input);
    this._modules.registerSystemModule(this._sound);
    this._modules.registerSystemModule(this._physics);
    this._modules.registerSystemModule(new ModuleBoot('boot'));
    this._modules.registerSystemModule(this._camera_mixer);

    // Module Initialization: 35% -> 100%
    LoadingStatus.updateStatus('Starting modules...', 40);
    await this._modules.start();

    LoadingStatus.updateStatus('Engine ready!', 100);
    this.initialized = true;
  }

  public static update(dt: number): void {
    if (!this.initialized || this.isRestarting) {
      return;
    }
    this._modules.update(dt * this._timeScale);

    //Engine.renderInMenu();
  }

  public static render(): void {
    if (!this.initialized || this.isRestarting) {
      return;
    }
    this._render.generateFrame();
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

      // Quality Settings Buttons

      this._debugUI.addButton('Engine', 'Low Quality', async () => {
        await this.applyQualityPresetAndRestart('LOW');
      });

      this._debugUI.addButton('Engine', 'Medium Quality', async () => {
        await this.applyQualityPresetAndRestart('MEDIUM');
      });

      this._debugUI.addButton('Engine', 'High Quality', async () => {
        await this.applyQualityPresetAndRestart('HIGH');
      });

      this._debugUI.addButton('Engine', 'Ultra Quality', async () => {
        await this.applyQualityPresetAndRestart('ULTRA');
      });

      this.debugControlsInitialized = true;
    }

    this._modules.renderInMenu();
  }

  public static stop(): void {
    if (!this.initialized) {
      return;
    }

    // Clean up modules
    this._modules.stop();
    this._debugUI.dispose();
    Render.getInstance().destroy();
    ResourceManager.stop();

    this.initialized = false;
    this.debugControlsInitialized = false;

    console.warn('Engine stopped.');
  }

  public static async restart(): Promise<void> {
    console.log('Restarting engine...');

    // Show loader during restart
    this.toggleLoader(true);

    // Set restarting flag to pause update/render loops
    this.isRestarting = true;

    // Wait longer to let current frame and any async operations finish
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Stop current engine
    this.stop();

    // Wait additional time to ensure complete cleanup of WebGPU resources
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Start engine again
    await this.start();

    // Clear restarting flag to resume update/render loops
    this.isRestarting = false;

    // Don't hide loader here - main.ts will handle it when isReady() returns true

    console.log('Engine restarted successfully.');
  }

  private static async applyQualityPresetAndRestart(
    presetName: keyof typeof QualitySettings.PRESETS,
  ): Promise<void> {
    const qualitySettings = QualitySettings.getInstance();

    console.log(`Applying ${presetName} quality preset...`);
    qualitySettings.applyPreset(presetName);

    // Restart engine to apply changes
    await this.restart();
  }

  public static toggleLoader(show: boolean): void {
    const loader = document.getElementById('loader');
    if (loader) {
      if (show) {
        loader.classList.remove('hidden');
      } else {
        loader.classList.add('hidden');
      }
    }
  }

  public static isReady(): boolean {
    return this.initialized && !this.isRestarting;
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

  public static getSound(): ModuleSound {
    return this._sound;
  }

  public static getPhysics(): ModulePhysics {
    return this._physics;
  }

  public static getCameraMixer(): ModuleCameraMixer {
    return this._camera_mixer;
  }

  public static getEnvironmentManager(): ModuleEnvironmentManager {
    return this._environment_manager;
  }

  public static getDebugUI(): DebugUIManager {
    return this._debugUI;
  }

  public static isEngineRestarting(): boolean {
    return this.isRestarting;
  }
}
