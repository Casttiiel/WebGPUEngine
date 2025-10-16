import * as CANNON from 'cannon-es';
import { vec3 } from 'gl-matrix';
import { ColliderComponent, ColliderData } from './ColliderComponent';

export interface BoxColliderData extends ColliderData {
  size: vec3;
}

export class BoxColliderComponent extends ColliderComponent {
  public override async load(data: BoxColliderData): Promise<void> {
    // Crear forma de caja
    this.shape = new CANNON.Box(
      new CANNON.Vec3(data.size[0] / 2, data.size[1] / 2, data.size[2] / 2),
    );

    // Llamar a la carga del componente base
    await super.load(data);
  }

  public override renderInMenu(): void {}

  public override renderDebug(): void {}
}
