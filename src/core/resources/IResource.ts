import { ResourceType } from '../../types/ResourceType.enum';

// Callback type for resource loading tracking
type LoadingTracker = {
  startLoading: (path: string) => void;
  finishLoading: (path: string) => void;
};

let loadingTracker: LoadingTracker | null = null;

export function setLoadingTracker(tracker: LoadingTracker): void {
  loadingTracker = tracker;
}

export interface IResourceOptions {
  path: string;
  type: ResourceType;
  dependencies?: string[];
}

export interface IResource {
  readonly path: string;
  readonly type: ResourceType;
  readonly hasData: boolean;
  readonly dependencies: Set<string>;
  refCount: number;

  load(): void;
  getDependencies(): Set<string>;
  addDependency(path: string): void;
  removeDependency(path: string): void;
  addRef(): void;
  release(): void;
}

export abstract class BaseResource implements IResource {
  public readonly path: string;
  public readonly type: ResourceType;
  public readonly dependencies: Set<string>;
  private _hasData: boolean = false;
  private _refCount: number = 0;

  constructor(options: IResourceOptions) {
    this.path = options.path;
    this.type = options.type;
    this.dependencies = new Set(options.dependencies || []);
  }

  release(): void {
    throw new Error('Method not implemented.');
  }

  get hasData(): boolean {
    return this._hasData;
  }

  get refCount(): number {
    return this._refCount;
  }

  set refCount(value: number) {
    this._refCount = value;
  }

  public abstract load(): void;

  // Public load method that wraps the abstract load with tracking
  public async loadWithTracking(): Promise<void> {
    if (loadingTracker) {
      loadingTracker.startLoading(this.path);
    }
    try {
      await this.load();
      this.setHasData();
    } finally {
      if (loadingTracker) {
        loadingTracker.finishLoading(this.path);
      }
    }
  }

  protected setHasData(): void {
    this._hasData = true;
  }

  public getDependencies(): Set<string> {
    return this.dependencies;
  }

  public addDependency(path: string): void {
    this.dependencies.add(path);
  }

  public removeDependency(path: string): void {
    this.dependencies.delete(path);
  }

  public addRef(): void {
    this._refCount++;
  }
}
