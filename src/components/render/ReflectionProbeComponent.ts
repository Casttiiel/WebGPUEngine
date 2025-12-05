import { Component } from '../../core/ecs/Component';

export class ReflectionProbeComponent extends Component {
  constructor() {
    super();
  }

  public load(data: string): void {}

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}
}
