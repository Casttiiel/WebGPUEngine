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

export class ModuleBoot extends Module {
  private playerCameraControllerComponent!: FPSCameraControllerComponent;
  private debugCameraComponent!: CameraComponent;
  private playerCharacterControllerComponent!: CharacterControllerComponent;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    LoadingStatus.updateStatus('Loading scene...', 65);
    const response = await ResourceManager.fetch(`data/boot.json`); //`assets/scenes/playground.json`
    const jsonData = await response.json();
    const finalScene = [];

    // Mergear todas las escenas en finalScene
    for (let sceneName of jsonData.scenes_to_load) {
      const sceneResponse = await ResourceManager.fetch(`assets/scenes/${sceneName}`);
      const jsonSceneData = await sceneResponse.json();

      // Mergear el array de la escena actual con finalScene
      finalScene.push(...jsonSceneData);
    }

    LoadingStatus.updateStatus('Parsing scene data...', 70);
    // 1. Parsear el JSON (expandir prefabs, GLTF, etc.)
    const parsedJson = await Loader.parseSceneJSON(finalScene);

    LoadingStatus.updateStatus('Processing instances...', 75);
    // 2. Flagear entidades que pueden ser instanciadas
    const flaggedJson = InstanceManager.flagInstanceableEntities(parsedJson);

    // 3. Cargar la escena con las entidades flaggeadas (80% - 90%)
    LoadingStatus.setProgressRange(80, 90);
    await Loader.loadSceneFromJSON(flaggedJson);

    LoadingStatus.updateStatus('Creating instance groups...', 92);
    // 4. Crear grupos de instancias (después de que todas las entities estén cargadas)
    const allEntities = Engine.getEntities().getAllEntities();
    await InstanceManager.createInstanceGroups(allEntities);

    return true;
  }

  public stop(): void {
    // ModuleBoot doesn't need cleanup - it's just initialization
    console.log('ModuleBoot stopped.');
  }

  public update(): void {
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
  }

  public renderDebug(): void {
    // ModuleBoot doesn't have debug info to render
  }
}
