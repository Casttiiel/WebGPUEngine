import { ResourceManager } from '../../core/engine/ResourceManager';
import { Loader } from '../../core/loaders/Loader';
import { Module } from '../core/Module';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { Engine } from '../../core/engine/Engine';
import { Logger } from '../../core/debug/Logger';
import { applyAnimLoopPreview } from '../../core/debug/AnimLoopPreview';
import { KeyCode } from '../../types/KeyCode.enum';
import { CameraComponent } from '../../components/render/CameraComponent';
import { FPSCameraControllerComponent } from '../../components/game/FPSCameraControllerComponent';
import { CameraArmComponent } from '../../components/game/CameraArmComponent';
import { TacticalCameraControllerComponent } from '../../components/game/tactical/TacticalCameraControllerComponent';
import { BasePlayerController } from '../../components/game/BasePlayerController';
import { PlayerSpawnComponent } from '../../components/game/PlayerSpawnComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { LinearInterpolator } from '../../core/math/Interpolators';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { GUIManager } from '../../core/debug/GUIManager';
import { DebugRenderState } from '../../core/debug/DebugRenderState';
import { EditorToolbar } from './EditorToolbar';

/** Component that controls the player camera — FPS, TPS arm or tactical rig. */
type PlayerCameraController =
  | FPSCameraControllerComponent
  | CameraArmComponent
  | TacticalCameraControllerComponent;

export class ModuleBoot extends Module {
  // Opcionales: una escena táctica no tiene Player (su cámara la mueve un rig táctico).
  private playerCameraControllerComponent: PlayerCameraController | null = null;
  private debugCameraComponent: CameraComponent | null = null;
  private playerCharacterControllerComponent: BasePlayerController | null = null;
  private sceneRefsResolved = false;
  private lastGamestate: string = '';

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    LoadingStatus.updateStatus('Loading scene files...');
    const tStart = performance.now();
    const response = await ResourceManager.fetch(`data/boot.json`);
    const jsonData = await response.json();
    const finalScene = [];

    // Dev: `?scene=a.json,b.json` sustituye las escenas de boot.json y `?scenario=nombre`
    // carga data/scenarios/nombre.json (escenas + entidades extra). Los usa el MCP.
    let scenesToLoad: string[] = jsonData.scenes_to_load;
    if (import.meta.env.DEV) {
      const params = new URLSearchParams(window.location.search);
      const scenarioName = params.get('scenario');
      if (scenarioName) {
        const scenarioResponse = await ResourceManager.fetch(`data/scenarios/${scenarioName}.json`);
        const scenario = await scenarioResponse.json();
        if (Array.isArray(scenario.scenes)) scenesToLoad = scenario.scenes;
        if (Array.isArray(scenario.entities)) finalScene.push(...scenario.entities);
        Logger.info('ENGINE', `Scenario '${scenarioName}'`);
      }
      const sceneParam = params.get('scene');
      if (sceneParam) scenesToLoad = sceneParam.split(',');
    }

    // Fetch all scene files in parallel, then merge in original order
    const sceneArrays = await Promise.all(
      scenesToLoad.map(async (sceneName: string) => {
        const sceneResponse = await ResourceManager.fetch(`assets/scenes/${sceneName}`);
        return sceneResponse.json();
      }),
    );
    for (const jsonSceneData of sceneArrays) {
      finalScene.push(...jsonSceneData);
    }

    LoadingStatus.updateStatus('Parsing scene data...');
    const parsedJson = await Loader.parseSceneJSON(finalScene);

    LoadingStatus.updateStatus('Processing instances...');
    const flaggedJson = InstanceManager.flagInstanceableEntities(parsedJson);

    LoadingStatus.updateStatus('Loading entities...');
    await Loader.loadSceneFromJSON(flaggedJson);

    // Dev: `?animLoop=Clip` — every animated character loops that clip (tools/anim previews)
    if (import.meta.env.DEV) {
      const animLoop = new URLSearchParams(window.location.search).get('animLoop');
      if (animLoop) await applyAnimLoopPreview(animLoop);
    }

    // Teleport player to spawn point if a player_spawn marker was found in the scene's GLTF
    const spawnPos = PlayerSpawnComponent.pendingPosition;
    const spawnYawDeg = PlayerSpawnComponent.pendingYawDeg;
    if (spawnPos) {
      const playerEntity = Engine.getEntities().getEntityByName('Player');
      if (playerEntity) {
        const capsule = playerEntity.getComponent('capsule_collider') as CapsuleColliderComponent;
        if (capsule?.getRigidBody()) {
          // The rigid body origin is at the capsule center, so offset Y by half the
          // total capsule height + the radius so the bottom hemisphere clears the ground.
          const spawnY = spawnPos[1] + capsule.getCapsuleHeight() / 2 + capsule.getCapsuleRadius();
          capsule
            .getRigidBody()
            .setTranslation({ x: spawnPos[0], y: spawnY, z: spawnPos[2] }, true);
        }

        // Apply spawn rotation to the FPS camera controller
        if (spawnYawDeg !== null) {
          const fpsCamera = playerEntity.getComponent(
            'fps_camera_controller',
          ) as FPSCameraControllerComponent;
          fpsCamera?.setInitialYaw(spawnYawDeg);
        }
      }
      PlayerSpawnComponent.pendingPosition = null;
      PlayerSpawnComponent.pendingYawDeg = null;
    }

    LoadingStatus.updateStatus('Creating instance groups...');
    const allEntities = Engine.getEntities().getAllEntities();
    await InstanceManager.createInstanceGroups(allEntities);

    Logger.info(
      'ENGINE',
      `Scene loaded (${scenesToLoad.join(', ')}): ${allEntities.length} entities in ${(performance.now() - tStart).toFixed(0)}ms`,
    );
    return true;
  }

  public stop(): void {
    // ModuleBoot doesn't need cleanup - it's just initialization
    Logger.info('ENGINE', 'Stopped');
  }

  /** Busca una vez los controllers de cámara/personaje de la escena (todos opcionales). */
  private resolveSceneRefs(): void {
    this.sceneRefsResolved = true;
    const entities = Engine.getEntities();

    const player = entities.getEntityByName('Player');
    if (player?.hasComponent('fps_camera_controller')) {
      this.playerCameraControllerComponent = player.getComponent(
        'fps_camera_controller',
      ) as FPSCameraControllerComponent;
    } else if (player?.hasComponent('camera_arm')) {
      this.playerCameraControllerComponent = player.getComponent(
        'camera_arm',
      ) as CameraArmComponent;
    } else {
      const tactical = entities.getObjectManagerByName('tactical_camera_controller')?.getList()[0];
      if (tactical)
        this.playerCameraControllerComponent = tactical as TacticalCameraControllerComponent;
    }

    if (player?.hasComponent('player_controller')) {
      this.playerCharacterControllerComponent = player.getComponent(
        'player_controller',
      ) as BasePlayerController;
    }

    const debugCamera = entities.getEntityByName('DebugCamera');
    if (debugCamera?.hasComponent('camera')) {
      this.debugCameraComponent = debugCamera.getComponent('camera') as CameraComponent;
    }
  }

  public update(_dt: number): void {
    if (!this.sceneRefsResolved) this.resolveSceneRefs();

    // F2: toggle between debug/game mode
    if (Engine.getInput().isKeyJustPressed(KeyCode.F2)) {
      this.toggleEditorMode();
    }

    // F3: toggle collider (non-sensor) wireframes
    if (Engine.getInput().isKeyJustPressed(KeyCode.F3)) {
      DebugRenderState.showColliders = !DebugRenderState.showColliders;
    }

    // F4: toggle sensor wireframes
    if (Engine.getInput().isKeyJustPressed(KeyCode.F4)) {
      DebugRenderState.showSensors = !DebugRenderState.showSensors;
    }

    // F5: toggle light debug
    if (Engine.getInput().isKeyJustPressed(KeyCode.F5)) {
      DebugRenderState.showLights = !DebugRenderState.showLights;
    }

    // F6: toggle camera debug
    if (Engine.getInput().isKeyJustPressed(KeyCode.F6)) {
      DebugRenderState.showCameras = !DebugRenderState.showCameras;
    }

    // Detectar gamestate y ajustar cámaras automáticamente
    const currentGamestate = Engine.getModules().getCurrentGamestate();

    // Solo cambiar cámaras si el gamestate cambió
    if (currentGamestate !== this.lastGamestate) {
      this.lastGamestate = currentGamestate;

      if (currentGamestate === 'gs_editor') {
        // Modo editor: activar DebugCamera, desactivar PlayerController, mostrar ImGui
        this.debugCameraComponent?.setActive(true);
        this.playerCameraControllerComponent?.setActive(false);
        this.playerCharacterControllerComponent?.setActive(false);
        const debugCamera = Engine.getEntities().getEntityByName('DebugCamera');
        if (debugCamera) {
          Engine.getCameraMixer().blendCamera(debugCamera, 1.0, new LinearInterpolator());
        }

        // Mostrar GUI UI
        GUIManager.getInstance().show();

        // Re-render menu to populate GUI controls
        Engine.renderInMenu();

        Logger.info('ENGINE', '📷 Debug camera');
      } else if (currentGamestate === 'gs_gameplay') {
        // Modo gameplay: activar PlayerCamera, activar PlayerController, ocultar ImGui
        this.debugCameraComponent?.setActive(false);
        this.playerCameraControllerComponent?.setActive(true);
        this.playerCharacterControllerComponent?.setActive(true);
        Engine.getCameraMixer().blendCamera(
          Engine.getEntities().getEntityByName('PlayerCamera')!,
          1.0,
          new LinearInterpolator(),
        );

        // Ocultar GUI UI
        GUIManager.getInstance().hide();

        Logger.info('ENGINE', '📷 Player camera');
      }
    }
  }

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (this.beginGUIWindow('Toolbar')) {
      const folder = gui.getFolder('Toolbar');
      if (folder) void EditorToolbar.build(folder);
      this.endGUIWindow();
    }
  }

  public renderDebug(): void {}

  private toggleEditorMode(): void {
    const currentGamestate = Engine.getModules().getCurrentGamestate();

    if (currentGamestate === 'gs_gameplay') {
      Logger.info('ENGINE', '🎨 Editor mode');
      Engine.getModules().changeToGamestate('gs_editor');
    } else if (currentGamestate === 'gs_editor') {
      Logger.info('ENGINE', '🎮 Gameplay mode');
      Engine.getModules().changeToGamestate('gs_gameplay');
    }
  }
}
