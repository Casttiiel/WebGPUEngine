import { ResourceManager } from '../../core/engine/ResourceManager';
import { Loader } from '../../core/loaders/Loader';
import { Module } from '../core/Module';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { Engine } from '../../core/engine/Engine';
import { KeyCode } from '../../types/KeyCode.enum';
import { CameraComponent } from '../../components/render/CameraComponent';
import { FPSCameraControllerComponent } from '../../components/game/FPSCameraControllerComponent';
import { CharacterControllerComponent } from '../../components/game/CharacterControllerComponent';
import { LinearInterpolator } from '../../core/math/Interpolators';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { GUIManager } from '../../core/debug/GUIManager';

export class ModuleBoot extends Module {
  private playerCameraControllerComponent!: FPSCameraControllerComponent;
  private debugCameraComponent!: CameraComponent;
  private playerCharacterControllerComponent!: CharacterControllerComponent;
  private lastGamestate: string = '';

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const t0 = performance.now();
    const ts = (label: string, from: number = t0) =>
      console.log(
        `%c[Boot] ${label}: +${(performance.now() - from).toFixed(0)}ms  (total: +${(performance.now() - t0).toFixed(0)}ms)`,
        'color:#80cbc4',
      );

    LoadingStatus.updateStatus('Loading scene files...');
    let tStep = performance.now();
    const response = await ResourceManager.fetch(`data/boot.json`);
    const jsonData = await response.json();
    const finalScene = [];

    // Fetch all scene files in parallel, then merge in original order
    const sceneArrays = await Promise.all(
      jsonData.scenes_to_load.map(async (sceneName: string) => {
        const sceneResponse = await ResourceManager.fetch(`assets/scenes/${sceneName}`);
        return sceneResponse.json();
      }),
    );
    for (const jsonSceneData of sceneArrays) {
      finalScene.push(...jsonSceneData);
    }
    ts(
      `Scene files fetched (${jsonData.scenes_to_load.length} files, ${finalScene.length} root entities)`,
      tStep,
    );

    LoadingStatus.updateStatus('Parsing scene data...');
    tStep = performance.now();
    const parsedJson = await Loader.parseSceneJSON(finalScene);
    ts('parseSceneJSON', tStep);

    LoadingStatus.updateStatus('Processing instances...');
    tStep = performance.now();
    const flaggedJson = InstanceManager.flagInstanceableEntities(parsedJson);
    ts('flagInstanceableEntities', tStep);

    LoadingStatus.updateStatus('Loading entities...');
    tStep = performance.now();
    await Loader.loadSceneFromJSON(flaggedJson);
    ts('loadSceneFromJSON', tStep);

    LoadingStatus.updateStatus('Creating instance groups...');
    tStep = performance.now();
    const allEntities = Engine.getEntities().getAllEntities();
    await InstanceManager.createInstanceGroups(allEntities);
    ts('createInstanceGroups', tStep);

    ts('\u2705 ModuleBoot.start() TOTAL');
    return true;
  }

  public stop(): void {
    // ModuleBoot doesn't need cleanup - it's just initialization
    console.log('ModuleBoot stopped.');
  }

  public update(dt: number): void {
    // Check F1 para toggle entre gs_gameplay y gs_editor
    if (Engine.getInput().isKeyJustPressed(KeyCode.F1)) {
      this.toggleEditorMode();
    }

    if (!this.playerCameraControllerComponent) {
      const player = Engine.getEntities().getEntityByName('Player')!;
      if (player.hasComponent('fps_camera_controller')) {
        this.playerCameraControllerComponent = player.getComponent(
          'fps_camera_controller',
        ) as FPSCameraControllerComponent;
      }
    }
    if (!this.playerCharacterControllerComponent) {
      const player = Engine.getEntities().getEntityByName('Player')!;
      if (player.hasComponent('character_controller')) {
        this.playerCharacterControllerComponent = player.getComponent(
          'character_controller',
        ) as CharacterControllerComponent;
      }
    }
    if (!this.debugCameraComponent) {
      const camera = Engine.getEntities().getEntityByName('DebugCamera')!;
      if (camera.hasComponent('camera')) {
        this.debugCameraComponent = camera.getComponent('camera') as CameraComponent;
      }
    }

    if (Engine.getInput().isKeyJustPressed(KeyCode.F1)) {
      this.debugCameraComponent.setActive(false);
      this.playerCameraControllerComponent.setActive(true);
      this.playerCharacterControllerComponent.setActive(true);
      Engine.getCameraMixer().blendCamera(
        Engine.getEntities().getEntityByName('PlayerCamera')!,
        1.0,
        new LinearInterpolator(),
      );
    }

    if (Engine.getInput().isKeyJustPressed(KeyCode.F2)) {
      this.debugCameraComponent.setActive(true);
      this.playerCameraControllerComponent.setActive(false);
      this.playerCharacterControllerComponent.setActive(false);
      Engine.getCameraMixer().blendCamera(
        Engine.getEntities().getEntityByName('DebugCamera')!,
        1.0,
        new LinearInterpolator(),
      );
    }

    // Detectar gamestate y ajustar cámaras automáticamente
    const currentGamestate = Engine.getModules().getCurrentGamestate();

    // Solo cambiar cámaras si el gamestate cambió
    if (currentGamestate !== this.lastGamestate) {
      this.lastGamestate = currentGamestate;

      if (currentGamestate === 'gs_editor') {
        // Modo editor: activar DebugCamera, desactivar PlayerController, mostrar ImGui
        this.debugCameraComponent.setActive(true);
        this.playerCameraControllerComponent.setActive(false);
        this.playerCharacterControllerComponent.setActive(false);
        Engine.getCameraMixer().blendCamera(
          Engine.getEntities().getEntityByName('DebugCamera')!,
          1.0,
          new LinearInterpolator(),
        );

        // Mostrar GUI UI
        GUIManager.getInstance().show();

        // Re-render menu to populate GUI controls
        Engine.renderInMenu();

        console.log('📷 DebugCamera activated (editor mode)');
      } else if (currentGamestate === 'gs_gameplay') {
        // Modo gameplay: activar PlayerCamera, activar PlayerController, ocultar ImGui
        this.debugCameraComponent.setActive(false);
        this.playerCameraControllerComponent.setActive(true);
        this.playerCharacterControllerComponent.setActive(true);
        Engine.getCameraMixer().blendCamera(
          Engine.getEntities().getEntityByName('PlayerCamera')!,
          1.0,
          new LinearInterpolator(),
        );

        // Ocultar GUI UI
        GUIManager.getInstance().hide();

        console.log('📷 PlayerCamera activated (gameplay mode)');
      }
    }
  }

  public renderDebug(): void {
    // ModuleBoot doesn't have debug info to render
  }

  /**
   * Toggle entre gs_gameplay y gs_editor
   */
  private toggleEditorMode(): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();

    if (currentGamestate === 'gs_gameplay') {
      console.log('🎨 Switching to EDITOR mode');
      Engine.getModules().changeToGamestate('gs_editor');
    } else if (currentGamestate === 'gs_editor') {
      console.log('🎮 Switching to GAMEPLAY mode');
      Engine.getModules().changeToGamestate('gs_gameplay');
    }
  }
}
