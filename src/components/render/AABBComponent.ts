import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { AABB } from '../../core/math/AABB';
import { AABBComponentDataType } from '../../types/AABBComponentData.type';

export class AABBComponent extends Component {
  protected aabb: AABB = new AABB();

  constructor() {
    super();
  }

  public async load(data: AABBComponentDataType): Promise<void> {
    if (data.min && data.max) {
      this.aabb = new AABB(
        vec3.fromValues(data.min.x, data.min.y, data.min.z),
        vec3.fromValues(data.max.x, data.max.y, data.max.z),
      );
    }
  }

  public update(dt: number): void {
    throw new Error('Method not implemented.');
  }

  debugInMenu(): void {
    // Implement debug menu if needed
  }

  renderDebug(): void {
    // Implement debug rendering if needed
  }

  updateFromSiblingsLocalAABBs(entity: Entity): void {
    console.log('TODO Updating AABB from siblings local AABBs');
    /*        const localAABBs = entity.getAllComponentsOfType<CompLocalAABB>(CompLocalAABB);
        
        if (localAABBs.length === 0) return;

        this.aabb = new AABB(
            vec3.clone(localAABBs[0].getAABB().min),
            vec3.clone(localAABBs[0].getAABB().max)
        );

        for (let i = 1; i < localAABBs.length; i++) {
            this.aabb.merge(localAABBs[i].getAABB());
        }*/
  }

  getAABB(): AABB {
    return this.aabb;
  }
}
