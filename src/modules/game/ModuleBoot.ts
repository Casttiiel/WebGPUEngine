import { ResourceManager } from '../../core/engine/ResourceManager';
import { Loader } from '../../core/loaders/Loader';
import { Module } from '../core/Module';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { Engine } from '../../core/engine/Engine';

export class ModuleBoot extends Module {
  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const response = await ResourceManager.fetch(`assets/scenes/scene.json`);
    const jsonData = await response.json();

    // 1. Parsear el JSON (expandir prefabs, GLTF, etc.)
    const parsedJson = await Loader.parseSceneJSON(jsonData);

    // 2. Flagear entidades que pueden ser instanciadas
    const flaggedJson = InstanceManager.flagInstanceableEntities(parsedJson);

    // 3. Cargar la escena con las entidades flaggeadas
    await Loader.loadSceneFromJSON(flaggedJson);

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
    // ModuleBoot doesn't need per-frame updates
  }

  public renderDebug(): void {
    // ModuleBoot doesn't have debug info to render
  }
}
