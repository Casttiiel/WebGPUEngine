import * as CANNON from 'cannon-es';
import { ColliderComponent, ColliderData } from './ColliderComponent';

export interface MeshColliderData extends ColliderData {
  vertices: number[];
  indices: number[];
}

export class MeshColliderComponent extends ColliderComponent {
  public override async load(data: MeshColliderData): Promise<void> {
    this.shape = new CANNON.Trimesh(data.vertices, data.indices);

    // Llamar a la carga del componente base
    await super.load(data);
  }

  public override renderInMenu(): void {}

  public override renderDebug(): void {}
}
