import RAPIER from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { vec3, quat } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';

export interface InfinitePlaneColliderData {
  normal?: vec3; // Normal del plano (por defecto [0, 1, 0] = suelo)
  friction?: number;
  restitution?: number;
  position?: vec3;
  rotation?: quat;
}

/**
 * InfinitePlaneColliderComponent - Collider de plano infinito
 *
 * Usa un halfspace de Rapier para simular un plano infinito.
 * IMPORTANTE: Los planos infinitos siempre son estáticos.
 */
export class InfinitePlaneColliderComponent extends Component {
  private rigidBody!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private transform!: TransformComponent;
  private normal: vec3;

  constructor() {
    super();
    // Por defecto el plano mira hacia arriba (suelo)
    this.normal = vec3.fromValues(0, 1, 0);
  }

  public async load(data: InfinitePlaneColliderData): Promise<void> {
    this.transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!this.transform) {
      throw new Error('InfinitePlaneCollider requires a TransformComponent');
    }

    // Configurar normal del plano
    if (data.normal) {
      vec3.copy(this.normal, data.normal);
      vec3.normalize(this.normal, this.normal);
    }

    // Obtener transformación mundial
    const worldPosition = data.position || this.transform.getTransform().getWorldPosition();
    const worldRotation = data.rotation || this.transform.getTransform().getWorldRotation();

    const physics = Engine.getPhysics();

    // Los planos infinitos son siempre estáticos
    this.rigidBody = physics.createStaticBody(this.getOwner().id, worldPosition);

    // Aplicar rotación
    this.rigidBody.setRotation(
      { x: worldRotation[0], y: worldRotation[1], z: worldRotation[2], w: worldRotation[3] },
      true,
    );

    // Crear un cuboid muy grande y plano para simular un plano infinito
    // En Rapier no hay halfspace, así que usamos un box de 1000x0.1x1000
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      1000.0, // Ancho enorme
      0.1, // Altura muy pequeña
      1000.0, // Profundidad enorme
    );

    // Configurar propiedades físicas
    if (data.friction !== undefined) {
      colliderDesc.setFriction(data.friction);
    } else {
      colliderDesc.setFriction(0.3); // Fricción por defecto
    }

    if (data.restitution !== undefined) {
      colliderDesc.setRestitution(data.restitution);
    } else {
      colliderDesc.setRestitution(0.3); // Rebote por defecto
    }

    // Crear el collider
    this.collider = physics.getWorld().createCollider(colliderDesc, this.rigidBody);

    // Registrar collider manualmente
    const entityId = this.getOwner().id;
    const colliders = physics['colliders'] as Map<number, RAPIER.Collider[]>;
    if (!colliders.has(entityId)) {
      colliders.set(entityId, []);
    }
    colliders.get(entityId)!.push(this.collider);
  }

  public update(_deltaTime: number): void {
    // Los planos infinitos son estáticos, no necesitan actualización
  }

  public dispose(): void {
    // Limpiar el cuerpo físico del mundo
    const physics = Engine.getPhysics();
    if (physics && this.rigidBody) {
      physics.removeBody(this.getOwner().id);
    }
  }

  // Getters útiles
  public getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  public getCollider(): RAPIER.Collider {
    return this.collider;
  }

  public getNormal(): vec3 {
    return this.normal;
  }


}
