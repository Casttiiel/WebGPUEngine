import { Component } from '../../core/ecs/Component';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { BoxColliderComponent } from '../physics/BoxColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { CharacterControllerComponent } from './CharacterControllerComponent';

export class ImpulsePadComponent extends Component {
  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();
  private force: number = 1.0;

  constructor() {
    super();
  }

  public load(data: unknown): void {
    this.force = data.force ?? 1.0;
  }

  public override async onAttach(): Promise<void> {
    // Esperar un frame para asegurar que el box_collider está cargado
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Registrar callbacks del trigger
    this.setupTriggerCallbacks();
  }

  private setupTriggerCallbacks(): void {
    const boxCollider = this.getOwner().getComponent('box_collider') as BoxColliderComponent;

    if (!boxCollider) {
      console.warn('Impulse pad: No se encontró box_collider (necesario para triggers)');
      return;
    }

    // Registrar callback para cuando algo ENTRA en el trigger
    boxCollider.onTriggerEnter((otherEntityId: number) => {
      this.onEntityEnter(otherEntityId);
    });

    // Registrar callback para cuando algo SALE del trigger
    boxCollider.onTriggerExit((otherEntityId: number) => {
      this.onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);

    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.add(entityId);
      (
        entity.getComponent('character_controller') as CharacterControllerComponent
      )?.applyImpulseFromPad(vec3.scale(vec3.create(), this.getUp(), this.force));
    }
  }

  private onEntityExit(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.delete(entityId);
    }
  }

  public update(): void {}

  public override renderInMenu(): void {}

  public renderDebug(): void {}

  private getUp(): vec3 {
    const transform = this.getOwner().getComponent('transform');
    if (!transform) {
      return vec3.create();
    }
    return (transform as TransformComponent).getTransform().getUp();
  }

  public getEntitiesInside(): Set<number> {
    return this.entitiesInside;
  }
}
