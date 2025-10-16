import * as CANNON from 'cannon-es';
import { vec3, quat } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';

export interface ColliderData {
  mass?: number;
  material?: {
    friction?: number;
    restitution?: number;
  };
  isTrigger?: boolean;
  position?: vec3;
  rotation?: quat;
}

/**
 * Componente base para todos los colliders
 */
export abstract class ColliderComponent extends Component {
  protected body!: CANNON.Body;
  protected shape!: CANNON.Shape;
  protected isTrigger: boolean = false;
  protected material!: CANNON.Material;

  constructor() {
    super();
  }

  public async load(data: ColliderData): Promise<void> {
    // Crear material físico
    this.material = new CANNON.Material({
      friction: data.material?.friction ?? 0.3,
      restitution: data.material?.restitution ?? 0.3,
    });

    // Crear cuerpo físico
    this.body = new CANNON.Body({
      mass: data.mass || 0,
      type: data.mass && data.mass > 0 ? CANNON.Body.DYNAMIC : CANNON.Body.STATIC,
      material: this.material,
    });

    // Configurar si es trigger
    this.isTrigger = data.isTrigger || false;
    if (this.isTrigger) {
      this.body.collisionResponse = false;
    }

    // Si hay una forma definida en las clases hijas, añadirla
    if (this.shape) {
      this.body.addShape(this.shape);
    }

    // Obtener el transform del entity
    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    if (transformComponent) {
      const position = data.position || transformComponent.getTransform().getWorldPosition();
      const rotation = data.rotation || transformComponent.getTransform().getWorldRotation();

      this.body.position.set(position[0], position[1], position[2]);
      this.body.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    }

    // Añadir al mundo físico
    Engine.getPhysics().addBody(this.body, this.getOwner().id);

    // Configurar eventos de colisión si es trigger
    if (this.isTrigger) {
      this.setupCollisionEvents();
    }
  }

  public update(deltaTime: number): void {
    if (!this.body) return;

    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    if (!transformComponent) return;

    if (this.body.mass > 0) {
      // Si es dinámico, actualizar transform desde física
      const pos = this.body.position;
      const rot = this.body.quaternion;

      transformComponent.getTransform().setLocalPosition(vec3.fromValues(pos.x, pos.y, pos.z));
      transformComponent.getTransform().setLocalRotation([rot.x, rot.y, rot.z, rot.w]);
    } else {
      // Si es estático, actualizar física desde transform
      const pos = transformComponent.getTransform().getWorldPosition();
      const rot = transformComponent.getTransform().getWorldRotation();

      this.body.position.set(pos[0], pos[1], pos[2]);
      this.body.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    }
  }

  public dispose(): void {
    if (this.body) {
      Engine.getPhysics().removeBody(this.getOwner().id);
    }
  }

  private setupCollisionEvents(): void {
    this.body.addEventListener('collide', (event: any) => {
      if (!this.isTrigger) return;

      // TODO: Implementar sistema de eventos para triggers
      console.log('Trigger collision:', event);
    });
  }

  // Getters útiles
  public getBody(): CANNON.Body {
    return this.body;
  }

  public getShape(): CANNON.Shape {
    return this.shape;
  }

  public setMass(mass: number): void {
    if (this.body) {
      this.body.mass = mass;
      this.body.updateMassProperties();
      this.body.type = mass > 0 ? CANNON.Body.DYNAMIC : CANNON.Body.STATIC;
    }
  }

  public applyForce(force: vec3, worldPoint?: vec3): void {
    if (!this.body || this.body.mass === 0) return;

    if (worldPoint) {
      this.body.applyForce(
        new CANNON.Vec3(force[0], force[1], force[2]),
        new CANNON.Vec3(worldPoint[0], worldPoint[1], worldPoint[2]),
      );
    } else {
      this.body.applyForce(new CANNON.Vec3(force[0], force[1], force[2]), new CANNON.Vec3(0, 0, 0));
    }
  }

  public applyImpulse(impulse: vec3, worldPoint?: vec3): void {
    if (!this.body || this.body.mass === 0) return;

    if (worldPoint) {
      this.body.applyImpulse(
        new CANNON.Vec3(impulse[0], impulse[1], impulse[2]),
        new CANNON.Vec3(worldPoint[0], worldPoint[1], worldPoint[2]),
      );
    } else {
      this.body.applyImpulse(
        new CANNON.Vec3(impulse[0], impulse[1], impulse[2]),
        new CANNON.Vec3(0, 0, 0),
      );
    }
  }
}
