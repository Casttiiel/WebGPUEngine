import RAPIER from '@dimforge/rapier3d';
import { vec3, quat } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { CollisionGroups, CollisionMasks } from '../../types/CollisionGroups.enum';

/**
 * Convierte un string del enum CollisionGroups a su valor numérico
 * Para collisionGroups (membership)
 */
function parseCollisionGroups(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;

  // Para groups, buscar solo en CollisionGroups
  if (value in CollisionGroups) {
    return CollisionGroups[value as keyof typeof CollisionGroups];
  }

  console.warn(`Unknown collision group: "${value}". Using default.`);
  return undefined;
}

/**
 * Convierte un string de CollisionMasks a su valor numérico
 * Para collisionMask (filter) - busca primero en CollisionGroups, luego en CollisionMasks
 */
function parseCollisionMask(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;

  // Buscar PRIMERO en CollisionGroups (grupos individuales como "PLAYER" -> 0x0001)
  if (value in CollisionGroups) {
    return CollisionGroups[value as keyof typeof CollisionGroups];
  }

  // Si no existe como grupo, buscar en CollisionMasks (máscaras predefinidas como "PLAYER_INTERACTIONS")
  if (value in CollisionMasks) {
    return CollisionMasks[value as keyof typeof CollisionMasks];
  }

  console.warn(`Unknown collision mask: "${value}". Using default.`);
  return undefined;
}

/**
 * Tipo de cuerpo rígido
 */
export enum RigidBodyType {
  DYNAMIC = 'dynamic', // Cuerpo dinámico (afectado por física)
  STATIC = 'static', // Cuerpo estático (no se mueve)
  KINEMATIC = 'kinematic', // Cuerpo cinemático (plataformas móviles)
}

/**
 * Tipo de collider
 */
export enum ColliderType {
  CUBOID = 'cuboid', // Caja
  SPHERE = 'sphere', // Esfera
  CAPSULE = 'capsule', // Cápsula (ideal para personajes)
  TRIMESH = 'trimesh', // Malla triangular (solo estático)
}

/**
 * Datos de configuración del collider
 */
export interface ColliderData {
  // Tipo de cuerpo rígido
  bodyType?: RigidBodyType;

  // Tipo de collider
  colliderType: ColliderType;

  // Propiedades físicas
  mass?: number;
  friction?: number;
  restitution?: number; // Rebote (0 = no rebota, 1 = rebota completamente)
  density?: number; // Densidad (alternativa a mass)

  // Trigger (sensor que no genera colisión física)
  isSensor?: boolean;

  // CCD (Continuous Collision Detection) para objetos rápidos
  enableCCD?: boolean;

  // Dimensiones del collider según el tipo
  // Para CUBOID: halfExtents [x, y, z]
  // Para SPHERE: radius
  // Para CAPSULE: [halfHeight, radius]
  // Para TRIMESH: se ignora (usa vertices e indices)
  dimensions: number[];

  // Datos para TRIMESH (solo si colliderType === TRIMESH)
  vertices?: number[];
  indices?: number[];

  // Posición y rotación inicial (opcional)
  position?: vec3;
  rotation?: quat;

  // Collision groups (para filtrado de colisiones)
  // Puede ser un número o un string del enum (ej: "DASH_TRIGGER", "PLAYER", "ENVIRONMENT")
  collisionGroups?: number | string;
  collisionMask?: number | string;

  ignoreTransformScale?: boolean;
}

/**
 * ColliderComponent - Componente base para física con Rapier
 *
 * Maneja la integración entre el ECS y el sistema de físicas Rapier.
 * Sincroniza transformaciones entre entidades y cuerpos rígidos.
 */
export class ColliderComponent extends Component {
  protected rigidBody!: RAPIER.RigidBody;
  protected collider!: RAPIER.Collider;
  protected bodyType: RigidBodyType = RigidBodyType.DYNAMIC;
  protected colliderType: ColliderType = ColliderType.CUBOID;
  protected isSensor: boolean = false;
  protected enableCCD: boolean = false;

  // Callbacks para triggers (sensores)
  private _onTriggerEnter?: (otherEntityId: number) => void;
  private _onTriggerExit?: (otherEntityId: number) => void;

  constructor() {
    super();
  }

  public async load(data: ColliderData): Promise<void> {
    this.bodyType = data.bodyType || RigidBodyType.DYNAMIC;
    this.colliderType = data.colliderType;
    this.isSensor = data.isSensor || false;
    this.enableCCD = data.enableCCD || false;

    // Obtener transform del entity
    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    const position = data.position || transformComponent.getTransform().getWorldPosition();
    const rotation = data.rotation || transformComponent.getTransform().getWorldRotation();

    const physics = Engine.getPhysics();

    // Crear cuerpo rígido según el tipo
    switch (this.bodyType) {
      case RigidBodyType.DYNAMIC:
        this.rigidBody = physics.createDynamicBody(this.getOwner().id, position, this.enableCCD);
        break;

      case RigidBodyType.STATIC:
      default:
        this.rigidBody = physics.createStaticBody(this.getOwner().id, position);
        break;

      case RigidBodyType.KINEMATIC:
        this.rigidBody = physics.createKinematicBody(this.getOwner().id, position);
        break;
    }

    // Aplicar rotación inicial
    this.rigidBody.setRotation(
      { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
      true,
    );

    // Crear collider según el tipo
    this.createCollider(data, physics);

    // Configurar propiedades físicas del collider
    if (data.friction !== undefined) {
      this.collider.setFriction(data.friction);
    }
    if (data.restitution !== undefined) {
      this.collider.setRestitution(data.restitution);
    }
    if (data.density !== undefined) {
      this.collider.setDensity(data.density);
    }

    // Configurar collision groups y mask (para filtrado)
    // Siempre configurar, incluso si no se especifica en data
    // Rapier usa un número de 32 bits:
    // - 16 bits ALTOS (left-most): membership (a qué grupos pertenece este collider)
    // - 16 bits BAJOS (right-most): filter (con qué grupos puede interactuar)
    // Formato: (membership << 16) | filter
    // Por defecto: ENVIRONMENT que interactúa con PLAYER | ENVIRONMENT | ENEMY
    const parsedGroups = parseCollisionGroups(data.collisionGroups);
    const parsedMask = parseCollisionMask(data.collisionMask);

    const membership = parsedGroups !== undefined ? parsedGroups : CollisionGroups.ENVIRONMENT;
    const filter = parsedMask !== undefined ? parsedMask : CollisionMasks.ENVIRONMENT;
    const combinedGroups = ((membership & 0xffff) << 16) | (filter & 0xffff);

    this.collider.setCollisionGroups(combinedGroups);
  }

  /**
   * Crea el collider según el tipo especificado
   */
  private createCollider(data: ColliderData, physics: any): void {
    const entityId = this.getOwner().id;

    // Obtener la escala del transform para aplicarla al collider
    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    const scale = data.ignoreTransformScale
      ? [1, 1, 1]
      : transformComponent.getTransform().getLocalScale();

    switch (this.colliderType) {
      case ColliderType.CUBOID:
        // dimensions = [halfX, halfY, halfZ]
        if (data.dimensions.length !== 3) {
          throw new Error('Cuboid collider requires 3 dimensions [halfX, halfY, halfZ]');
        }
        // Aplicar escala del transform a las dimensiones del collider
        const scaledHalfExtents = vec3.fromValues(
          data.dimensions[0]! * scale[0],
          data.dimensions[1]! * scale[1],
          data.dimensions[2]! * scale[2],
        );
        this.collider = physics.addCuboidCollider(
          entityId,
          this.rigidBody,
          scaledHalfExtents,
          this.isSensor,
        );
        break;

      case ColliderType.SPHERE:
        // dimensions = [radius]
        if (data.dimensions.length !== 1) {
          throw new Error('Sphere collider requires 1 dimension [radius]');
        }
        // Aplicar escala promedio (para esferas, tomar el mayor componente)
        const scaledRadius = data.dimensions[0]! * Math.max(scale[0], scale[1], scale[2]);
        this.collider = physics.addSphereCollider(
          entityId,
          this.rigidBody,
          scaledRadius,
          this.isSensor,
        );
        break;

      case ColliderType.CAPSULE:
        // dimensions = [halfHeight, radius]
        if (data.dimensions.length !== 2) {
          throw new Error('Capsule collider requires 2 dimensions [halfHeight, radius]');
        }
        // Aplicar escala: Y para altura, X/Z para radio
        const scaledHalfHeight = data.dimensions[0]! * scale[1]; // Y axis
        const scaledCapsuleRadius = data.dimensions[1]! * Math.max(scale[0], scale[2]); // X/Z axis
        this.collider = physics.addCapsuleCollider(
          entityId,
          this.rigidBody,
          scaledHalfHeight,
          scaledCapsuleRadius,
          this.isSensor,
        );
        break;

      case ColliderType.TRIMESH:
        // TRIMESH: datos de vértices e índices
        if (!data.vertices || data.vertices.length === 0) {
          console.warn('MeshCollider: No vertices data, skipping collider creation');
          return;
        }
        if (!data.indices || data.indices.length === 0) {
          console.warn('MeshCollider: No indices data, skipping collider creation');
          return;
        }

        // Validar que los índices sean múltiplos de 3 (triángulos)
        if (data.indices.length % 3 !== 0) {
          console.error('MeshCollider: Indices must be multiple of 3 (triangles)');
          return;
        }

        // Aplicar la escala del transform a los vértices del trimesh
        const scaledVertices = new Float32Array(data.vertices.length);
        for (let i = 0; i < data.vertices.length; i += 3) {
          scaledVertices[i] = data.vertices[i]! * scale[0]; // X
          scaledVertices[i + 1] = data.vertices[i + 1]! * scale[1]; // Y
          scaledVertices[i + 2] = data.vertices[i + 2]! * scale[2]; // Z
        }

        const indices = new Uint32Array(data.indices);

        // Crear descriptor de trimesh con vértices escalados
        const trimeshDesc = RAPIER.ColliderDesc.trimesh(scaledVertices, indices);

        // Configurar propiedades
        if (this.isSensor) {
          trimeshDesc.setSensor(this.isSensor);
        }
        if (data.friction !== undefined) {
          trimeshDesc.setFriction(data.friction);
        }
        if (data.restitution !== undefined) {
          trimeshDesc.setRestitution(data.restitution);
        }
        // Siempre configurar collision groups, incluso con valores por defecto
        // Por defecto: ENVIRONMENT que interactúa con PLAYER | ENVIRONMENT | ENEMY
        const parsedGroups = parseCollisionGroups(data.collisionGroups);
        const parsedMask = parseCollisionMask(data.collisionMask);

        const membership = parsedGroups !== undefined ? parsedGroups : CollisionGroups.ENVIRONMENT;
        const filter = parsedMask !== undefined ? parsedMask : CollisionMasks.ENVIRONMENT;
        const combinedGroups = ((membership & 0xffff) << 16) | (filter & 0xffff);
        trimeshDesc.setCollisionGroups(combinedGroups);

        // Crear collider
        this.collider = physics.getWorld().createCollider(trimeshDesc, this.rigidBody);

        // Registrar manualmente en el mapa de colliders
        const colliders = physics['colliders'] as Map<number, RAPIER.Collider[]>;
        if (!colliders.has(entityId)) {
          colliders.set(entityId, []);
        }
        colliders.get(entityId)!.push(this.collider);
        break;

      default:
        throw new Error(`Unknown collider type: ${this.colliderType}`);
    }
  }

  public update(_deltaTime: number): void {
    if (!this.rigidBody) return;

    const transformComponent = this.getOwner().getComponent('transform') as TransformComponent;
    if (!transformComponent) return;

    if (this.bodyType === RigidBodyType.DYNAMIC) {
      // Si es dinámico, actualizar transform desde física
      const translation = this.rigidBody.translation();
      const rotation = this.rigidBody.rotation();

      transformComponent
        .getTransform()
        .setLocalPosition(vec3.fromValues(translation.x, translation.y, translation.z));
      transformComponent
        .getTransform()
        .setLocalRotation([rotation.x, rotation.y, rotation.z, rotation.w]);
    } else if (this.bodyType === RigidBodyType.KINEMATIC) {
      // Si es cinemático, actualizar física desde transform
      // (para mover plataformas desde código)
      /*const pos = transformComponent.getTransform().getWorldPosition();
      const rot = transformComponent.getTransform().getWorldRotation();

      this.rigidBody.setNextKinematicTranslation({ x: pos[0], y: pos[1], z: pos[2] });
      this.rigidBody.setNextKinematicRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] });*/
      const translation = this.rigidBody.translation();
      const rotation = this.rigidBody.rotation();

      transformComponent
        .getTransform()
        .setLocalPosition(vec3.fromValues(translation.x, translation.y, translation.z));
      transformComponent
        .getTransform()
        .setLocalRotation([rotation.x, rotation.y, rotation.z, rotation.w]);
    }
    // Si es estático, no necesita sincronización (no se mueve)
  }

  public renderDebug(): void {
    // TODO: Implementar debug rendering del collider
  }

  public dispose(): void {
    if (this.rigidBody) {
      Engine.getPhysics().removeBody(this.getOwner().id);
    }
  }

  // ==================== Getters ====================

  public getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  public getCollider(): RAPIER.Collider {
    return this.collider;
  }

  public getBodyType(): RigidBodyType {
    return this.bodyType;
  }

  public isSensorCollider(): boolean {
    return this.isSensor;
  }

  public setCollider(collider: RAPIER.Collider): void {
    this.collider = collider;
  }

  // ==================== Physics API ====================

  /**
   * Aplica una fuerza al cuerpo rígido
   */
  public applyForce(force: vec3, wake: boolean = true): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.addForce({ x: force[0], y: force[1], z: force[2] }, wake);
  }

  /**
   * Aplica un impulso al cuerpo rígido (cambio instantáneo de velocidad)
   */
  public applyImpulse(impulse: vec3, wake: boolean = true): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, wake);
  }

  /**
   * Aplica torque (rotación)
   */
  public applyTorque(torque: vec3, wake: boolean = true): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.addTorque({ x: torque[0], y: torque[1], z: torque[2] }, wake);
  }

  /**
   * Establece la velocidad lineal del cuerpo
   */
  public setLinearVelocity(velocity: vec3, wake: boolean = true): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, wake);
  }

  /**
   * Obtiene la velocidad lineal del cuerpo
   */
  public getLinearVelocity(): vec3 {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) {
      return vec3.create();
    }

    const vel = this.rigidBody.linvel();
    return vec3.fromValues(vel.x, vel.y, vel.z);
  }

  /**
   * Establece la velocidad angular del cuerpo
   */
  public setAngularVelocity(velocity: vec3, wake: boolean = true): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.setAngvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, wake);
  }

  /**
   * Bloquea rotaciones en ciertos ejes (útil para personajes)
   */
  public lockRotations(lockX: boolean, lockY: boolean, lockZ: boolean): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.setEnabledRotations(!lockX, !lockY, !lockZ, true);
  }

  /**
   * Habilita/deshabilita el cuerpo rígido
   */
  public setEnabled(enabled: boolean): void {
    if (!this.rigidBody) return;

    this.rigidBody.setEnabled(enabled);
  }

  /**
   * Pone el cuerpo en modo sleeping (ahorro de CPU)
   */
  public sleep(): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.sleep();
  }

  /**
   * Despierta el cuerpo del modo sleeping
   */
  public wakeUp(): void {
    if (!this.rigidBody || this.bodyType !== RigidBodyType.DYNAMIC) return;

    this.rigidBody.wakeUp();
  }

  /**
   * Registra callback para cuando otro collider ENTRA en este trigger
   * Solo funciona si isSensor = true
   */
  public onTriggerEnter(callback: (otherEntityId: number) => void): void {
    this._onTriggerEnter = callback;
  }

  /**
   * Registra callback para cuando otro collider SALE de este trigger
   * Solo funciona si isSensor = true
   */
  public onTriggerExit(callback: (otherEntityId: number) => void): void {
    this._onTriggerExit = callback;
  }

  /**
   * Método interno llamado por ModulePhysics cuando se detecta entrada al trigger
   */
  public _notifyTriggerEnter(otherEntityId: number): void {
    if (this._onTriggerEnter) {
      this._onTriggerEnter(otherEntityId);
    }
  }

  /**
   * Método interno llamado por ModulePhysics cuando se detecta salida del trigger
   */
  public _notifyTriggerExit(otherEntityId: number): void {
    if (this._onTriggerExit) {
      this._onTriggerExit(otherEntityId);
    }
  }
}
