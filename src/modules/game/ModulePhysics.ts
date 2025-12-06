import { Module } from '../core/Module';
import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';

/**
 * ModulePhysics - Sistema de físicas usando Rapier
 *
 * Rapier es un motor de físicas moderno (Rust → WASM) con:
 * - Mejor rendimiento y gestión de memoria que Cannon.js
 * - Soporte para CCD (Continuous Collision Detection) para balas rápidas
 * - Cuerpos cinemáticos para plataformas móviles
 * - Triggers, collision filtering, raycasts
 * - API limpia y sin memory leaks
 */
export class ModulePhysics extends Module {
  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private debugEnabled: boolean = false;

  // Mapeo de entity IDs a rigid bodies
  private bodies: Map<number, RAPIER.RigidBody> = new Map();
  private colliders: Map<number, RAPIER.Collider[]> = new Map();

  // Mapeo de collider handles a entity IDs (para eventos de colisión)
  private colliderHandleToEntityId: Map<number, number> = new Map();

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    try {
      // Inicializar Rapier (WASM) - La inicialización es automática en versiones nuevas
      // await RAPIER.init(); // No necesario en versiones recientes

      // Crear el mundo físico con gravedad
      const gravity = { x: 0.0, y: -9.81, z: 0.0 };
      this.world = new RAPIER.World(gravity);

      // Crear cola de eventos para detectar colisiones
      this.eventQueue = new RAPIER.EventQueue(true);

      console.log('Rapier physics initialized successfully');
      return true;
    } catch (error) {
      console.error('Error initializing Rapier physics:', error);
      return false;
    }
  }

  public stop(): void {
    // Limpiar todos los cuerpos y colliders
    this.bodies.forEach((body) => {
      this.world.removeRigidBody(body);
    });
    this.bodies.clear();
    this.colliders.clear();

    // Liberar recursos de Rapier
    if (this.world) {
      this.world.free();
    }
    if (this.eventQueue) {
      this.eventQueue.free();
    }
  }

  public update(_deltaTime: number): void {
    // Actualizar la simulación física con timestep fijo
    this.world.timestep = _deltaTime;
    this.world.step(this.eventQueue);

    // Procesar eventos de colisión
    this.processCollisionEvents();
  }

  public renderDebug(): void {
    if (!this.debugEnabled) return;

    // TODO: Implementar visualización de debug de físicas
    // Dibujar wireframes de colliders usando debugRender de Rapier
  }

  public override renderInMenu(): void {
    // TODO: Agregar controles de debug UI (gravity, timestep, etc.)
  }

  /**
   * Crea un cuerpo rígido dinámico
   */
  public createDynamicBody(
    entityId: number,
    position: vec3,
    enableCCD: boolean = false,
  ): RAPIER.RigidBody {
    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position[0], position[1], position[2])
      .setCcdEnabled(enableCCD); // CCD para balas/proyectiles rápidos

    const body = this.world.createRigidBody(rigidBodyDesc);
    this.bodies.set(entityId, body);

    return body;
  }

  /**
   * Crea un cuerpo rígido estático (suelo, paredes)
   */
  public createStaticBody(entityId: number, position: vec3): RAPIER.RigidBody {
    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      position[0],
      position[1],
      position[2],
    );

    const body = this.world.createRigidBody(rigidBodyDesc);
    this.bodies.set(entityId, body);

    return body;
  }

  /**
   * Crea un cuerpo cinemático (plataformas móviles)
   * El personaje se moverá junto con la plataforma
   */
  public createKinematicBody(entityId: number, position: vec3): RAPIER.RigidBody {
    const rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(
      position[0],
      position[1],
      position[2],
    );

    const body = this.world.createRigidBody(rigidBodyDesc);
    this.bodies.set(entityId, body);

    return body;
  }

  /**
   * Añade un collider cápsula (ideal para personajes)
   */
  public addCapsuleCollider(
    entityId: number,
    body: RAPIER.RigidBody,
    halfHeight: number,
    radius: number,
    isSensor: boolean = false,
  ): RAPIER.Collider {
    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setSensor(isSensor);

    colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    colliderDesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);

    const collider = this.world.createCollider(colliderDesc, body);

    // Guardar collider en el mapa
    if (!this.colliders.has(entityId)) {
      this.colliders.set(entityId, []);
    }
    this.colliders.get(entityId)!.push(collider);

    // Registrar handle para eventos
    this.colliderHandleToEntityId.set(collider.handle, entityId);

    return collider;
  }

  /**
   * Añade un collider cuboid (caja)
   */
  public addCuboidCollider(
    entityId: number,
    body: RAPIER.RigidBody,
    halfExtents: vec3,
    isSensor: boolean = false,
  ): RAPIER.Collider {
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      halfExtents[0],
      halfExtents[1],
      halfExtents[2],
    ).setSensor(isSensor);

    const collider = this.world.createCollider(colliderDesc, body);

    if (!this.colliders.has(entityId)) {
      this.colliders.set(entityId, []);
    }
    this.colliders.get(entityId)!.push(collider);

    // Registrar handle para eventos
    this.colliderHandleToEntityId.set(collider.handle, entityId);

    return collider;
  }

  /**
   * Añade un collider esfera
   */
  public addSphereCollider(
    entityId: number,
    body: RAPIER.RigidBody,
    radius: number,
    isSensor: boolean = false,
  ): RAPIER.Collider {
    const colliderDesc = RAPIER.ColliderDesc.ball(radius).setSensor(isSensor);

    colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    colliderDesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);

    const collider = this.world.createCollider(colliderDesc, body);

    if (!this.colliders.has(entityId)) {
      this.colliders.set(entityId, []);
    }
    this.colliders.get(entityId)!.push(collider);

    // Registrar handle para eventos
    this.colliderHandleToEntityId.set(collider.handle, entityId);

    return collider;
  }

  public createCharacterControllerPhysicsForCollider(): RAPIER.KinematicCharacterController {
    let controller = this.world.createCharacterController(0.01); // min distance para evitar jitter

    controller.enableSnapToGround(0.3);
    controller.setSlideEnabled(true);

    controller.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((30 * Math.PI) / 180);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.disableSnapToGround();

    return controller;
  }

  /**
   * Elimina un cuerpo físico del mundo
   */
  public removeBody(entityId: number): void {
    const body = this.bodies.get(entityId);
    if (body) {
      this.world.removeRigidBody(body);
      this.bodies.delete(entityId);
    }

    // Eliminar colliders asociados
    this.colliders.delete(entityId);
  }

  /**
   * Obtiene un cuerpo físico por entity ID
   */
  public getBody(entityId: number): RAPIER.RigidBody | undefined {
    return this.bodies.get(entityId);
  }

  /**
   * Realiza un raycast en el mundo físico
   * Útil para detección de disparos, line of sight, etc.
   */
  public raycast(
    from: vec3,
    direction: vec3,
    maxDistance: number,
    solid: boolean = true,
  ): RAPIER.RayColliderHit | null {
    const ray = new RAPIER.Ray(
      { x: from[0], y: from[1], z: from[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );

    const hit = this.world.castRay(ray, maxDistance, solid);
    return hit;
  }

  /**
   * Obtiene el mundo físico de Rapier
   */
  public getWorld(): RAPIER.World {
    return this.world;
  }

  /**
   * Procesa eventos de colisión de la cola de eventos
   */
  private processCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      const entityId1 = this.colliderHandleToEntityId.get(handle1);
      const entityId2 = this.colliderHandleToEntityId.get(handle2);

      if (entityId1 === undefined || entityId2 === undefined) {
        return;
      }

      // Obtener colliders de Rapier
      const collider1 = this.world.getCollider(handle1);
      const collider2 = this.world.getCollider(handle2);

      if (!collider1 || !collider2) {
        return;
      }

      // Verificar si alguno es sensor (trigger)
      const isSensor1 = collider1.isSensor();
      const isSensor2 = collider2.isSensor();

      if (!isSensor1 && !isSensor2) {
        return; // Colisión normal, no es trigger
      }

      // Notificar a los componentes ColliderComponent
      if (started) {
        // Trigger ENTER
        if (isSensor1) {
          this.notifyTriggerEnter(entityId1, entityId2);
        }
        if (isSensor2) {
          this.notifyTriggerEnter(entityId2, entityId1);
        }
      } else {
        // Trigger EXIT
        if (isSensor1) {
          this.notifyTriggerExit(entityId1, entityId2);
        }
        if (isSensor2) {
          this.notifyTriggerExit(entityId2, entityId1);
        }
      }
    });

    // Procesar eventos de contacto (información más detallada)
    this.eventQueue.drainContactForceEvents((_event) => {
      // event contiene información sobre fuerzas de contacto
      // Útil para detectar impactos fuertes, etc.
    });
  }

  /**
   * Notifica a un ColliderComponent que otro collider entró en su trigger
   */
  private notifyTriggerEnter(triggerEntityId: number, otherEntityId: number): void {
    const entity = this.getEntityById(triggerEntityId);
    if (!entity) return;

    // Buscar componentes collider (puede tener box_collider, capsule_collider, etc.)
    const colliderComponents = [
      entity.getComponent('box_collider'),
      entity.getComponent('capsule_collider'),
      entity.getComponent('sphere_collider'),
      entity.getComponent('mesh_collider'),
    ].filter((c) => c !== null);

    for (const collider of colliderComponents) {
      if (collider && typeof (collider as any)._notifyTriggerEnter === 'function') {
        (collider as any)._notifyTriggerEnter(otherEntityId);
      }
    }
  }

  /**
   * Notifica a un ColliderComponent que otro collider salió de su trigger
   */
  private notifyTriggerExit(triggerEntityId: number, otherEntityId: number): void {
    const entity = this.getEntityById(triggerEntityId);
    if (!entity) return;

    // Buscar componentes collider
    const colliderComponents = [
      entity.getComponent('box_collider'),
      entity.getComponent('capsule_collider'),
      entity.getComponent('sphere_collider'),
      entity.getComponent('mesh_collider'),
    ].filter((c) => c !== null);

    for (const collider of colliderComponents) {
      if (collider && typeof (collider as any)._notifyTriggerExit === 'function') {
        (collider as any)._notifyTriggerExit(otherEntityId);
      }
    }
  }

  /**
   * Obtiene una entidad por su ID (helper para eventos)
   */
  private getEntityById(entityId: number): any {
    // Importar Engine solo cuando sea necesario para evitar circular dependencies
    const entities = Engine.getEntities();

    // Buscar la entidad en todas las entidades registradas
    const allEntities = entities.getAllEntities();
    for (const entity of allEntities) {
      if (entity.id === entityId) {
        return entity;
      }
    }

    return null;
  }

  /**
   * Activa/desactiva debug rendering
   */
  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }
}
