import { ModuleManager } from '../../modules/core/ModuleManager';
import { ModuleBoot } from '../../modules/game/ModuleBoot';
import { ModuleCameraMixer } from '../../modules/game/ModuleCameraMixer';
import { ModuleGamePaused } from '../../modules/game/ModuleGamePaused';
import { ModuleGameController } from '../../modules/game/ModuleGameController';
import { ModuleEditorSelection } from '../../modules/game/ModuleEditorSelection';
import { ModuleMainMenu } from '../../modules/game/ModuleMainMenu';
import { ModuleEntities } from '../../modules/core/ModuleEntities';
import { ModuleEnvironmentManager } from '../../modules/core/ModuleEnvironmentManager';
import { ModuleInput } from '../../modules/core/ModuleInput';
import { ModulePhysics } from '../../modules/core/ModulePhysics';
import { ModuleRender } from '../../modules/core/ModuleRender';
import { ModuleSound } from '../../modules/core/ModuleSound';
import { Render } from '../../renderer/core/pipeline/Render';
import { LoadingStatus } from './LoadingStatus';
import { QualitySettings } from './QualitySettings';
import { ResourceManager } from './ResourceManager';
import { ModuleUI } from '../../modules/core/ModuleUI';
import { GUIManager } from '../debug/GUIManager';

export class Engine {
  private static initialized: boolean = false;
  private static isRestarting: boolean = false;

  private static _modules: ModuleManager;
  private static _render: ModuleRender;
  private static _entities: ModuleEntities;
  private static _camera_mixer: ModuleCameraMixer;
  private static _sound: ModuleSound;
  private static _input: ModuleInput;
  private static _physics: ModulePhysics;
  private static _ui: ModuleUI;
  private static _environment_manager: ModuleEnvironmentManager;
  private static _timeScale: number = 1.0;
  private static _guiManager: GUIManager = GUIManager.getInstance();

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

    console.warn('Engine started.');

    try {
      // WebGPU Initialization: 0% -> 25%
      LoadingStatus.updateStatus('Initializing WebGPU...', 0);
      const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
      const initialized = await Render.getInstance().initialize(canvas);

      if (!initialized) {
        throw new Error('Failed to initialize WebGPU. Your browser may not support WebGPU.');
      }
      LoadingStatus.updateStatus('WebGPU initialized', 25);

      // Initialize GUI for editor UI
      await this._guiManager.initialize();

      // Module Creation: 25% -> 30%
      LoadingStatus.updateStatus('Creating module manager...', 30);
      this._modules = new ModuleManager();

      // Module Registration: 30% -> 40%
      LoadingStatus.updateStatus('Registering modules...', 35);
      this._render = new ModuleRender('render');
      this._physics = new ModulePhysics('physics');
      this._camera_mixer = new ModuleCameraMixer('camera_mixer');
      this._sound = new ModuleSound('sound');
      this._input = new ModuleInput('input');
      this._entities = new ModuleEntities('entities');
      this._environment_manager = new ModuleEnvironmentManager('environment_manager');
      this._ui = new ModuleUI('ui');

      //UI Module
      //Game controler Module

      this._modules.registerSystemModule(this._environment_manager);
      this._modules.registerSystemModule(this._render);
      this._modules.registerSystemModule(this._entities);
      this._modules.registerSystemModule(this._input);
      this._modules.registerSystemModule(this._sound);
      this._modules.registerSystemModule(this._physics);
      this._modules.registerSystemModule(this._ui);

      this._modules.registerGameModule(this._camera_mixer);
      this._modules.registerGameModule(new ModuleBoot('boot'));
      this._modules.registerGameModule(new ModuleGameController('game_controller'));
      this._modules.registerGameModule(new ModuleGamePaused('game_paused'));
      this._modules.registerGameModule(new ModuleEditorSelection('editor_selection'));
      this._modules.registerGameModule(new ModuleMainMenu('main_menu'));

      // Module Initialization: 40% -> 100% (dinámico según módulos)
      LoadingStatus.updateStatus('Starting modules...', 40);
      await this._modules.start();

      // Initialize debug UI controls once (Tweakpane + Lil-GUI)
      this.renderInMenu();

      LoadingStatus.updateStatus('Engine ready!', 100);
      this.initialized = true;
    } catch (error) {
      console.error('Error during engine initialization:', error);
      LoadingStatus.showError(error as Error);
      throw error; // Re-throw para que main.ts lo capture también
    }
  }

  public static update(dt: number): void {
    if (!this.initialized || this.isRestarting) {
      return;
    }
    this._modules.update(dt * this._timeScale);

    // Update GUI (no-op for lil-gui, kept for compatibility)
    this._guiManager.update(dt * this._timeScale);
  }

  public static renderInMenu(): void {
    // Delegate to modules to render their debug UI (Tweakpane + ImGui)
    this._modules.renderInMenu();
  }

  public static render(): void {
    if (!this.initialized || this.isRestarting) {
      return;
    }
    this._render.generateFrame();
    this._modules.renderDebug();

    // End GUI frame and render UI
    this._guiManager.endFrame();
  }

  public static stop(): void {
    if (!this.initialized) {
      return;
    }

    // Clean up modules
    this._modules.stop();
    this._guiManager.dispose();
    Render.getInstance().destroy();
    ResourceManager.stop();

    this.initialized = false;

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

  public static getUI(): ModuleUI {
    return this._ui;
  }

  public static getGUI(): GUIManager {
    return this._guiManager;
  }

  public static isEngineRestarting(): boolean {
    return this.isRestarting;
  }
}
