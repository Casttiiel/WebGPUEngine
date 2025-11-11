import RAPIER from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { vec3, quat } from 'gl-matrix';

export interface MeshColliderData {
  vertices: number[]; // Array de vértices [x, y, z, x, y, z, ...]
  indices: number[]; // Array de índices [i0, i1, i2, ...]
  position?: vec3;
  rotation?: quat;
  friction?: number;
  restitution?: number;
  isSensor?: boolean;
  collisionGroups?: number;
  collisionMask?: number;
}

/**
 * MeshColliderComponent - Collider de malla triangular
 *
 * Usa un trimesh de Rapier para geometría compleja.
 * IMPORTANTE: Los mesh colliders solo funcionan con cuerpos estáticos.
 * Para cuerpos dinámicos, usar formas convexas simples (box, sphere, capsule).
 */
export class MeshColliderComponent extends Component {
  private rigidBody!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;

  public async load(data: MeshColliderData): Promise<void> {
    // Obtener transform del entity
    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    const position = data.position || transformComponent.getTransform().getWorldPosition();
    const rotation = data.rotation || transformComponent.getTransform().getWorldRotation();

    const physics = Engine.getPhysics();

    // Los mesh colliders solo funcionan con cuerpos estáticos en Rapier
    this.rigidBody = physics.createStaticBody(this.getOwner().id, position);

    // Aplicar rotación
    this.rigidBody.setRotation(
      { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
      true,
    );

    // Crear descriptor de collider trimesh
    const colliderDesc = RAPIER.ColliderDesc.trimesh(
      new Float32Array(data.vertices),
      new Uint32Array(data.indices),
    );

    // Configurar como sensor si es necesario
    if (data.isSensor) {
      colliderDesc.setSensor(data.isSensor);
    }

    // Configurar propiedades físicas
    if (data.friction !== undefined) {
      colliderDesc.setFriction(data.friction);
    }
    if (data.restitution !== undefined) {
      colliderDesc.setRestitution(data.restitution);
    }

    // Configurar collision groups
    if (data.collisionGroups !== undefined) {
      colliderDesc.setCollisionGroups(data.collisionGroups);
    }

    // Crear el collider
    this.collider = physics.getWorld().createCollider(colliderDesc, this.rigidBody);

    // Registrar collider manualmente (como hacen los métodos add*Collider)
    const entityId = this.getOwner().id;
    const colliders = physics['colliders'] as Map<number, RAPIER.Collider[]>;
    if (!colliders.has(entityId)) {
      colliders.set(entityId, []);
    }
    colliders.get(entityId)!.push(this.collider);
  }

  public update(_deltaTime: number): void {
    // Los mesh colliders estáticos no necesitan actualización
  }

  public dispose(): void {
    if (this.rigidBody) {
      Engine.getPhysics().removeBody(this.getOwner().id);
    }
  }

  public getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  public getCollider(): RAPIER.Collider {
    return this.collider;
  }

  public override renderInMenu(): void {
    // TODO: Implementar debug UI
  }

  public override renderDebug(): void {
    // TODO: Implementar debug rendering (wireframe del mesh)
  }
}
