import { Module } from '../core/Module';
import RAPIER from '@dimforge/rapier3d';
import { vec3 } from 'gl-matrix';

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
  private fixedTimeStep: number = 1.0 / 60.0;
  private debugEnabled: boolean = false;

  // Mapeo de entity IDs a rigid bodies
  private bodies: Map<number, RAPIER.RigidBody> = new Map();
  private colliders: Map<number, RAPIER.Collider[]> = new Map();

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
    this.world.timestep = this.fixedTimeStep;
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
    const rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
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
    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setSensor(isSensor); // Sensor = trigger (no física, solo detección)

    const collider = this.world.createCollider(colliderDesc, body);

    // Guardar collider en el mapa
    if (!this.colliders.has(entityId)) {
      this.colliders.set(entityId, []);
    }
    this.colliders.get(entityId)!.push(collider);

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

    const collider = this.world.createCollider(colliderDesc, body);

    if (!this.colliders.has(entityId)) {
      this.colliders.set(entityId, []);
    }
    this.colliders.get(entityId)!.push(collider);

    return collider;
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
    this.eventQueue.drainCollisionEvents((_handle1, _handle2, started) => {
      // handle1 y handle2 son los colliders que colisionaron
      // started = true si es el inicio de la colisión, false si es el fin

      // TODO: Implementar sistema de eventos para notificar a componentes
      // Por ejemplo: disparar evento onCollisionEnter/onCollisionExit

      if (started) {
        // Colisión comenzó
        // console.log('Collision started:', handle1, handle2);
      } else {
        // Colisión terminó
        // console.log('Collision ended:', handle1, handle2);
      }
    });

    // Procesar eventos de contacto (información más detallada)
    this.eventQueue.drainContactForceEvents((_event) => {
      // event contiene información sobre fuerzas de contacto
      // Útil para detectar impactos fuertes, etc.
    });
  }

  /**
   * Activa/desactiva debug rendering
   */
  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }
}
