import { MaterialDataType } from '../../types/MaterialData.type';
import { EntityDataType } from '../../types/SceneData.type';
import { TechniqueDataType } from '../../types/TechniqueData.type';
import { IResource, setLoadingTracker } from '../resources/IResource';
import { ShaderPreprocessor } from '../../renderer/core/processing/ShaderPreprocessor';

// Type for managed resource tracking
interface ResourceEntry {
  resource: IResource;
}

export class ResourceManager {
  private static resources: Map<string, ResourceEntry> = new Map();
  private static loadingResources: Set<string> = new Set(); // Track resources currently loading
  private static initialized: boolean = false;

  constructor() {
    throw new Error('Cannot create instances of this class');
  }

  public static initialize(): void {
    if (!this.initialized) {
      // Set up the loading tracker
      setLoadingTracker({
        startLoading: (path: string) => this.startLoadingResource(path),
        finishLoading: (path: string) => this.finishLoadingResource(path),
      });
      this.initialized = true;
    }
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

  // Loading state management
  public static startLoadingResource(path: string): void {
    this.loadingResources.add(path);
  }

  public static finishLoadingResource(path: string): void {
    this.loadingResources.delete(path);
  }

  public static isLoading(): boolean {
    return this.loadingResources.size > 0;
  }

  public static getLoadingCount(): number {
    return this.loadingResources.size;
  }

  public static getLoadingResources(): string[] {
    return Array.from(this.loadingResources);
  }

  public static waitForAllResources(): Promise<void> {
    return new Promise((resolve) => {
      const checkLoading = () => {
        if (!this.isLoading()) {
          resolve();
        } else {
          // Check again in next frame
          requestAnimationFrame(checkLoading);
        }
      };
      checkLoading();
    });
  }

  // Data loading utilities
  public static async loadPrefab(prefabName: string): Promise<EntityDataType> {
    const prefab = await ResourceManager.fetch(`assets/prefabs/${prefabName}`).then((res) =>
      res.json(),
    );
    return prefab;
  }

  public static async loadMeshData(meshPath: string): Promise<string> {
    return await ResourceManager.fetch(`assets/meshes/${meshPath}`).then((res) => res.text());
  }

  public static async loadMaterialData(materialPath: string): Promise<MaterialDataType> {
    return await ResourceManager.fetch(`assets/materials/${materialPath}`).then((res) =>
      res.json(),
    );
  }

  public static async loadTechniqueData(techniquePath: string): Promise<TechniqueDataType> {
    return await ResourceManager.fetch(`assets/techniques/${techniquePath}`).then((res) =>
      res.json(),
    );
  }

  public static async fetch(input: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${import.meta.env.BASE_URL}${input}`, init);
    } catch (err) {
      console.error('ResourceManager.fetch error:', input, err);
      throw err;
    }
  }

  public static fetchWithTracking(input: string, init?: RequestInit): Promise<Response> {
    // Start tracking this resource
    this.startLoadingResource(input);

    // Create the fetch promise
    const fetchPromise = this.fetch(input, init);

    // Add cleanup when promise resolves or rejects
    fetchPromise
      .then(() => this.finishLoadingResource(input))
      .catch(() => this.finishLoadingResource(input));

    return fetchPromise;
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
