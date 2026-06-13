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
import { Logger } from '../debug/Logger';
import { HealthComponent } from '../../components/game/HealthComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { FXAAComponent } from '../../components/render/FXAAComponent';
import { SMAAComponent } from '../../components/render/SMAAComponent';
import { SMAAT2xComponent } from '../../components/render/SMAAT2xComponent';
import { TAAComponent } from '../../components/render/TAAComponent';
import { TSRComponent } from '../../components/render/TSRComponent';
import { AmbientOcclusionComponent } from '../../components/render/AmbientOcclusionComponent';
import { BloomComponent } from '../../components/render/BloomComponent';
import { DepthOfFieldComponent } from '../../components/render/DepthOfFieldComponent';
import { MotionBlurComponent } from '../../components/render/MotionBlurComponent';
import { FSRComponent } from '../../components/render/FSRComponent';
import { PaletteQuantizeComponent } from '../../components/render/PaletteQuantizeComponent';
import { GodRaysComponent } from '../../components/render/GodRaysComponent';
import { ContactShadowsComponent } from '../../components/render/ContactShadowsComponent';
import { BloodDrainSourceComponent } from '../../components/game/BloodDrainSourceComponent';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { WeakPointComponent } from '../../components/game/combat/WeakPointComponent';
import { TankMeleeController } from '../../components/game/TankMeleeController';
import { LensFlareComponent } from '../../components/render/LensFlareComponent';
import { ChromaticAberrationComponent } from '../../components/render/ChromaticAberrationComponent';
import { FilmGrainComponent } from '../../components/render/FilmGrainComponent';
import { VignetteComponent } from '../../components/render/VignetteComponent';
import { HeightFogComponent } from '../../components/vfx/HeightFogComponent';
import { AtmosphericFogComponent } from '../../components/vfx/AtmosphericFogComponent';
import { ImpulsePadComponent } from '../../components/game/ImpulsePadComponent';
import { SwingBarComponent } from '../../components/game/SwingBarComponent';
import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { GrappleTargetComponent } from '../../components/game/GrappleTargetComponent';
import { ChargeTargetComponent } from '../../components/game/ChargeTargetComponent';
import { CombatDirectorComponent } from '../../components/game/CombatDirectorComponent';
import { HitReactionComponent } from '../../components/game/HitReactionComponent';

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
      Logger.warn('ENGINE', 'Already running');
      return;
    }

    Logger.info('ENGINE', 'Starting...');

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

      // Register all component message subscriptions (once, before modules start)
      Engine.registerAllMsgs();

      // Module Initialization: 40% -> 100% (dinámico según módulos)
      LoadingStatus.updateStatus('Starting modules...', 40);
      await this._modules.start();

      // Initialize debug UI controls once (Tweakpane + Lil-GUI)
      this.renderInMenu();

      LoadingStatus.updateStatus('Engine ready!', 100);
      this.initialized = true;
      Logger.info('ENGINE', `Ready  ·  ${QualitySettings.getInstance().getCurrentQualityName()}`);
    } catch (error) {
      Logger.error('ENGINE', 'Initialization failed', error);
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

  /**
   * Registra las suscripciones de mensajes de todos los componentes del motor.
   * Añadir aquí el `ComponentClass.registerMsgs()` de cada nuevo componente.
   */
  private static registerAllMsgs(): void {
    HealthComponent.registerMsgs();
    // Render / Post-process — RESIZE
    ToneMappingComponent.registerMsgs();
    FXAAComponent.registerMsgs();
    SMAAComponent.registerMsgs();
    SMAAT2xComponent.registerMsgs();
    TAAComponent.registerMsgs();
    TSRComponent.registerMsgs();
    AmbientOcclusionComponent.registerMsgs();
    BloomComponent.registerMsgs();
    DepthOfFieldComponent.registerMsgs();
    MotionBlurComponent.registerMsgs();
    FSRComponent.registerMsgs();
    PaletteQuantizeComponent.registerMsgs();
    GodRaysComponent.registerMsgs();
    ContactShadowsComponent.registerMsgs();
    BloodDrainSourceComponent.registerMsgs();
    LensFlareComponent.registerMsgs();
    ChromaticAberrationComponent.registerMsgs();
    FilmGrainComponent.registerMsgs();
    VignetteComponent.registerMsgs();
    HeightFogComponent.registerMsgs();
    AtmosphericFogComponent.registerMsgs();
    // Triggers / Física — TRIGGER_ENTER / TRIGGER_EXIT
    ImpulsePadComponent.registerMsgs();
    SwingBarComponent.registerMsgs();
    ReflectionProbeComponent.registerMsgs();
    GrappleTargetComponent.registerMsgs();
    ChargeTargetComponent.registerMsgs();
    EnemyControllerComponent.registerMsgs();
    WeakPointComponent.registerMsgs();
    TankMeleeController.registerMsgs();
    CombatDirectorComponent.registerMsgs();
    HitReactionComponent.registerMsgs();
    // Nuevos componentes con mensajes se añaden aquí:
    // StaminaComponent.registerMsgs();
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

    Logger.info('ENGINE', 'Stopped');
  }

  public static async restart(): Promise<void> {
    Logger.info('ENGINE', 'Restarting...');

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

    Logger.info('ENGINE', 'Restarted');
  }

  private static async applyQualityPresetAndRestart(
    presetName: keyof typeof QualitySettings.PRESETS,
  ): Promise<void> {
    const qualitySettings = QualitySettings.getInstance();

    Logger.info('ENGINE', `Quality preset: ${presetName}`);
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
