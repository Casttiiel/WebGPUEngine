import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { ColliderComponent, ColliderData, ColliderType, RigidBodyType } from './ColliderComponent';
import { Engine } from '../../core/engine/Engine';

export interface CapsuleColliderData extends Omit<ColliderData, 'colliderType' | 'dimensions'> {
  height: number; // Altura total de la cápsula (incluyendo las semiesferas)
  radius: number; // Radio de la cápsula
  lockRotationX?: boolean; // Bloquear rotación en eje X (default: false)
  lockRotationY?: boolean; // Bloquear rotación en eje Y (default: false)
  lockRotationZ?: boolean; // Bloquear rotación en eje Z (default: false)
}

/**
 * CapsuleColliderComponent - Collider de cápsula genérico
 *
 * Características:
 * - Soporte para cualquier tipo de RigidBody (STATIC, KINEMATIC, DYNAMIC)
 * - Bloqueo de rotaciones configurable por eje
 * - Cápsula vertical ideal para personajes, pilares, obstáculos cilíndricos
 * - Métodos de utilidad para raycast de grounded detection
 *
 * Uso genérico:
 * {
 *   "capsule_collider": {
 *     "height": 2.0,
 *     "radius": 0.5,
 *     "bodyType": "STATIC",
 *     "friction": 0.5
 *   }
 * }
 *
 * Uso para character (player/NPC):
 * {
 *   "capsule_collider": {
 *     "height": 1.8,
 *     "radius": 0.3,
 *     "bodyType": "DYNAMIC",
 *     "lockRotationX": true,
 *     "lockRotationZ": true,
 *     "friction": 0.0,
 *     "mass": 70.0
 *   }
 * }
 */
export class CapsuleColliderComponent extends ColliderComponent {
  private capsuleHeight: number = 1.8;
  private capsuleRadius: number = 0.3;

  public async loadCapsule(data: CapsuleColliderData): Promise<void> {
    this.capsuleHeight = data.height;
    this.capsuleRadius = data.radius;

    // Calcular halfHeight (altura del cilindro central)
    const halfHeight = Math.max(0.01, (data.height - 2 * data.radius) / 2);

    // Usar el bodyType especificado, por defecto DYNAMIC
    const colliderData: ColliderData = {
      ...data,
      bodyType: data.bodyType || RigidBodyType.DYNAMIC,
      colliderType: ColliderType.CAPSULE,
      dimensions: [halfHeight, data.radius],
      friction: data.friction !== undefined ? data.friction : 0.5,
      mass: data.mass !== undefined ? data.mass : 1.0,
    };

    await super.load(colliderData);

    // Aplicar bloqueo de rotaciones si está configurado
    if (this.rigidBody) {
      const lockX = data.lockRotationX ?? false;
      const lockY = data.lockRotationY ?? false;
      const lockZ = data.lockRotationZ ?? false;

      // Rapier.lockRotations(lockX, lockZ) - nota: Y no se puede bloquear directamente
      // En Rapier, lockRotations(x, z) bloquea pitch y roll
      if (lockX || lockZ) {
        this.rigidBody.lockRotations(lockX, lockZ);
      }

      // Para bloquear Y (yaw), usamos setEnabledRotations
      if (lockY) {
        this.rigidBody.setEnabledRotations(false, true, false, true);
      }
    }
  }

  public override async load(data: unknown): Promise<void> {
    await this.loadCapsule(data as CapsuleColliderData);
  }

  /**
   * Raycast hacia abajo para detectar si está en el suelo
   * Útil para character controllers
   * @param castDistance - Distancia del raycast hacia abajo
   * @returns true si detecta suelo
   */
  public raycastGrounded(castDistance: number = 0.1): RAPIER.RayColliderIntersection | null {
    if (!this.rigidBody || !this.collider) return null;

    const physics = Engine.getPhysics();
    if (!physics) return false;

    const pos = this.rigidBody.translation();

    // Start the ray 5 cm above the capsule bottom (inside the capsule) so RAPIER
    // reliably detects a floor at exactly the capsule's resting position.
    // Casting from the exact boundary (pos.y - height/2) can return null when the
    // ray origin coincides with the top face of a static box at distance=0.
    const skinOffset = 0.05;
    const ray = new RAPIER.Ray(
      { x: pos.x, y: pos.y - this.capsuleHeight / 2.0 + skinOffset, z: pos.z },
      { x: 0, y: -1, z: 0 },
    );

    // Excluir el propio collider del raycast
    const hit = physics.getWorld().castRayAndGetNormal(
      ray,
      castDistance + skinOffset,
      true, // solid
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined, // sin filtro de grupos
      this.collider, // Excluir solo el propio collider
    );
    return hit;
  }

  /**
   * Establece la velocidad lineal del RigidBody
   * Útil para character controllers
   */
  public override setLinearVelocity(velocity: vec3, wake: boolean = true): void {
    if (!this.rigidBody) return;

    this.rigidBody.setLinvel(
      {
        x: velocity[0],
        y: velocity[1],
        z: velocity[2],
      },
      wake,
    );
  }

  /**
   * Obtiene la velocidad lineal actual
   */
  public override getLinearVelocity(): vec3 {
    if (!this.rigidBody) return vec3.create();

    const vel = this.rigidBody.linvel();
    return vec3.fromValues(vel.x, vel.y, vel.z);
  }

  /**
   * Obtiene el RigidBody de Rapier
   */
  public override getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody!;
  }

  public getCapsuleHeight(): number {
    return this.capsuleHeight;
  }

  public getCapsuleRadius(): number {
    return this.capsuleRadius;
  }

  public override renderDebug(): void {
    // TODO: Wireframe capsule, raycast visualization
  }
}
