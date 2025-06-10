import { Component } from '../../core/ecs/Component';

export class NameComponent extends Component {
  private name: string = '';

  constructor() {
    super();
  }

  public async load(data: string): Promise<void> {
    this.name = data;
  }

  public update(dt: number): void {
    // Name components don't need update logic by default
  }

  public renderInMenu(): void {}

  public renderDebug(): void {}

  public getName(): string {
    return this.name;
  }
}
