import { Entity } from './Entity';

export abstract class Component {
  private owner!: Entity;
  public enabled: boolean = true;

  constructor() {}

  public abstract load(data: unknown): void;
  public abstract update(dt: number): void;
  public abstract renderDebug(): void;

  // Base method for debug UI that components can override.
  // If a raw lil-gui folder is passed, the component should add its controls there.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public renderInMenu(_folder?: any): void {}

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
