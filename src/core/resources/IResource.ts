import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../engine/ResourceManager';

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

  load(): Promise<void>;
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

  get hasData(): boolean {
    return this._hasData;
  }

  get refCount(): number {
    return this._refCount;
  }

  set refCount(value: number) {
    this._refCount = value;
  }

  public abstract load(): Promise<void>;

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

  public release(): void {
    if (--this._refCount <= 0) {
      this.unload().catch((err) => console.error(`Error unloading resource ${this.path}: ${err}`));
    }
  }
}
