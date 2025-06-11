import { MaterialDataType } from '../../types/MaterialData.type';
import { EntityDataType } from '../../types/SceneData.type';
import { TechniqueDataType } from '../../types/TechniqueData.type';
import { IResource } from '../resources/IResource';
import { ShaderPreprocessor } from '../../renderer/core/ShaderPreprocessor';

// Type for managed resource tracking
interface ResourceEntry {
  resource: IResource;
}

export class ResourceManager {
  private static resources: Map<string, ResourceEntry> = new Map();

  constructor() {
    throw new Error('Cannot create instances of this class');
  }

  public static getResource<T extends IResource>(path: string): T {
    const entry = this.resources.get(path);

    if (!entry) {
      throw new Error(`Resource not found: ${path}`);
    }

    entry.resource.addRef();
    return entry.resource as T;
  }

  public static registerResource<T extends IResource>(resource: T): void {
    if (this.resources.has(resource.path)) {
      const existing = this.resources.get(resource.path)!;
      if (existing.resource !== resource) {
        throw new Error(`Different resource already registered with path: ${resource.path}`);
      }
      return;
    }

    const entry: ResourceEntry = {
      resource,
    };

    this.resources.set(resource.path, entry);
  }

  public static unregisterResource(path: string): void {
    const entry = this.resources.get(path);
    if (entry && entry.resource.refCount <= 0) {
      entry.resource.unload().catch(console.error);
      this.resources.delete(path);
    }
  }

  // Data loading utilities
  public static async loadPrefab(prefabName: string): Promise<EntityDataType> {
    const prefab = await fetch(`/assets/prefabs/${prefabName}`).then((res) => res.json());
    return prefab;
  }

  public static async loadMeshData(meshPath: string): Promise<string> {
    return await fetch(`/assets/meshes/${meshPath}`).then((res) => res.text());
  }

  public static async loadMaterialData(materialPath: string): Promise<MaterialDataType> {
    return await fetch(`/assets/materials/${materialPath}`).then((res) => res.json());
  }

  public static async loadTechniqueData(techniquePath: string): Promise<TechniqueDataType> {
    return await fetch(`/assets/techniques/${techniquePath}`).then((res) => res.json());
  }

  public static async loadShader(shaderPath: string): Promise<string> {
    // Always use preprocessor to handle includes
    try {
      return await ShaderPreprocessor.preprocessShader(shaderPath);
    } catch (error) {
      console.error(`Error loading shader ${shaderPath}:`, error);
      throw error;
    }
  }
}
