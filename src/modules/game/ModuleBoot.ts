import { ResourceManager } from '../../core/engine/ResourceManager';
import { Loader } from '../../core/loaders/Loader';
import { Module } from '../core/Module';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { Engine } from '../../core/engine/Engine';
import { Logger } from '../../core/debug/Logger';
import { KeyCode } from '../../types/KeyCode.enum';
import { CameraComponent } from '../../components/render/CameraComponent';
import { FPSCameraControllerComponent } from '../../components/game/FPSCameraControllerComponent';
import { BasePlayerController } from '../../components/game/BasePlayerController';
import { PlayerSpawnComponent } from '../../components/game/PlayerSpawnComponent';
import { CapsuleColliderComponent } from '../../components/physics/CapsuleColliderComponent';
import { LinearInterpolator } from '../../core/math/Interpolators';
import { LoadingStatus } from '../../core/engine/LoadingStatus';
import { GUIManager } from '../../core/debug/GUIManager';

export class ModuleBoot extends Module {
  private playerCameraControllerComponent!: FPSCameraControllerComponent;
  private debugCameraComponent!: CameraComponent;
  private playerCharacterControllerComponent!: BasePlayerController;
  private lastGamestate: string = '';

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
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

    LoadingStatus.updateStatus('Parsing scene data...');
    tStep = performance.now();
    const parsedJson = await Loader.parseSceneJSON(finalScene);

    LoadingStatus.updateStatus('Processing instances...');
    tStep = performance.now();
    const flaggedJson = InstanceManager.flagInstanceableEntities(parsedJson);

    LoadingStatus.updateStatus('Loading entities...');
    tStep = performance.now();
    await Loader.loadSceneFromJSON(flaggedJson);

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
    tStep = performance.now();
    const allEntities = Engine.getEntities().getAllEntities();
    await InstanceManager.createInstanceGroups(allEntities);

    return true;
  }

  public stop(): void {
    // ModuleBoot doesn't need cleanup - it's just initialization
    Logger.info('ENGINE', 'Stopped');
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
      if (player.hasComponent('player_controller')) {
        this.playerCharacterControllerComponent = player.getComponent(
          'player_controller',
        ) as BasePlayerController;
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

        Logger.info('ENGINE', '📷 Debug camera');
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

        Logger.info('ENGINE', '📷 Player camera');
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
      Logger.info('ENGINE', '🎨 Editor mode');
      Engine.getModules().changeToGamestate('gs_editor');
    } else if (currentGamestate === 'gs_editor') {
      Logger.info('ENGINE', '🎮 Gameplay mode');
      Engine.getModules().changeToGamestate('gs_gameplay');
    }
  }
}
