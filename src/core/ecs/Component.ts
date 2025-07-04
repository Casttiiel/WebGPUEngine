import { Entity } from './Entity';

export abstract class Component {
  private owner!: Entity;

  constructor() {}

  public abstract load(data: unknown): Promise<void>;
  public abstract update(dt: number): void;
  public abstract renderDebug(): void;

  // Base method for debug UI that components can override
  public renderInMenu(): void {}

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
