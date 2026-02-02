import { MaterialDataType } from '../../types/MaterialData.type';
import { EntityDataType } from '../../types/SceneData.type';
import { TechniqueDataType } from '../../types/TechniqueData.type';
import { IResource } from '../resources/IResource';
import { ShaderPreprocessor } from '../../renderer/core/processing/ShaderPreprocessor';

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
      this.resources.delete(path);
    }
  }

  // Data loading utilities
  public static async loadPrefab(prefabName: string): Promise<EntityDataType> {
    const response = await ResourceManager.fetch(`assets/prefabs/${prefabName}`);
    return await response.json();
  }

  public static async loadMeshData(meshPath: string): Promise<string> {
    const response = await ResourceManager.fetch(`assets/meshes/${meshPath}`);
    return await response.text();
  }

  public static async loadMaterialData(materialPath: string): Promise<MaterialDataType> {
    const response = await ResourceManager.fetch(`assets/materials/${materialPath}`);
    return await response.json();
  }

  public static async loadTechniqueData(techniquePath: string): Promise<TechniqueDataType> {
    const response = await ResourceManager.fetch(`assets/techniques/${techniquePath}`);
    return await response.json();
  }

  public static async fetch(input: string, init?: RequestInit): Promise<Response> {
    const fullPath = `${import.meta.env.BASE_URL}${input}`;
    try {
      const response = await fetch(fullPath, init);

      if (!response.ok) {
        throw new Error(
          `Failed to load resource: ${input}\n` +
            `Full path: ${fullPath}\n` +
            `Status: ${response.status} ${response.statusText}\n` +
            `This usually means the file doesn't exist or the path is incorrect.`,
        );
      }

      return response;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Failed to load resource')) {
        throw err; // Re-throw our custom error
      }
      console.error(`ResourceManager.fetch error loading: ${input}`, err);
      throw new Error(`Network error loading: ${input} - ${err}`);
    }
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

  public static stop(): void {
    this.resources = new Map();
    this.loadingResources = new Set(); // Clear loading resources as well
  }
}
