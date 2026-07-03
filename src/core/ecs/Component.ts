import { Entity } from './Entity';

export abstract class Component {
  private owner!: Entity;
  public enabled: boolean = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _editorFolder: any = null;

  constructor() {}

  public abstract load(data: unknown): void;
  public abstract update(dt: number): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public renderDebug(_filter?: string): void {}

  // Base method for debug UI that components can override.
  // If a raw lil-gui folder is passed, the component should add its controls there.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public renderInMenu(_folder?: any): void {}

  // Called by Entity.renderInMenu so each component appears under its entity in Scene,
  // even if it has already registered in a category panel (Post Processing, Atmosphere…).
  // Temporarily clears the guard so renderInMenu can run a second time with a different parent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public renderInEntityPanel(folder: any): void {
    const prev = this._editorFolder;
    this._editorFolder = null;
    this.renderInMenu(folder);
    if (!this._editorFolder) this._editorFolder = prev;
  }

  // Called after the component is attached to an entity and loaded
  // Override this to set up dependencies on other components
  public async onAttach(): Promise<void> {}

  public dispose(): void {}

  public setOwner(owner: Entity): void {
    this.owner = owner;
  }

  public getOwner(): Entity {
    if (!this.owner) {
      throw new Error('Component has no owner');
    }
    return this.owner;
  }
}
