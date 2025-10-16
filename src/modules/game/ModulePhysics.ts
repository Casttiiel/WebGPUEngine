import { Module } from '../core/Module';
import * as CANNON from 'cannon-es';
import { vec3 } from 'gl-matrix';

export class ModulePhysics extends Module {
  private world!: CANNON.World;
  private fixedTimeStep: number = 1.0 / 60.0;
  private maxSubSteps: number = 3;
  private debugEnabled: boolean = false;
  private bodies: Map<number, CANNON.Body> = new Map();

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    try {
      // Crear el mundo físico con configuración optimizada
      this.world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0),
        allowSleep: true, // Activar sleeping
        quatNormalizeFast: true, // Usar normalización rápida de quaterniones
        quatNormalizeSkip: 3, // Normalizar cada N pasos
      });

      // Configurar broadphase óptimo (SAP es mejor para la mayoría de casos)
      this.world.broadphase = new CANNON.SAPBroadphase(this.world);

      // Ajustar parámetros de broadphase
      this.world.broadphase.useBoundingBoxes = true; // Usar AABB para mejor precisión

      // Configurar manejador de contactos
      this.setupContactHandler();

      return true;
    } catch (error) {
      console.error('Error initializing physics system:', error);
      return false;
    }
  }

  public stop(): void {
    // Limpiar todos los cuerpos físicos
    this.bodies.forEach((body) => {
      this.world.removeBody(body);
    });
    this.bodies.clear();
  }

  public update(deltaTime: number): void {
    // Actualizar la simulación física
    this.world.step(this.fixedTimeStep, deltaTime, this.maxSubSteps);
  }

  public renderDebug(): void {
    if (!this.debugEnabled) return;

    // TODO: Implementar visualización de debug de físicas
    // Dibujar wireframes de colliders, etc.
  }

  public override renderInMenu(): void {}

  /**
   * Añade un cuerpo físico al mundo
   */
  public addBody(body: CANNON.Body, entityId: number): void {
    this.world.addBody(body);
    this.bodies.set(entityId, body);
  }

  /**
   * Elimina un cuerpo físico del mundo
   */
  public removeBody(entityId: number): void {
    const body = this.bodies.get(entityId);
    if (body) {
      this.world.removeBody(body);
      this.bodies.delete(entityId);
    }
  }

  /**
   * Realiza un raycast en el mundo físico
   */
  public raycast(from: vec3, to: vec3): CANNON.RaycastResult {
    const result = new CANNON.RaycastResult();
    const ray = new CANNON.Ray();

    ray.from.set(from[0], from[1], from[2]);
    ray.to.set(to[0], to[1], to[2]);

    ray.intersectWorld(this.world, {
      mode: CANNON.Ray.CLOSEST,
      result: result,
    });

    return result;
  }

  /**
   * Obtiene el mundo físico
   */
  public getWorld(): CANNON.World {
    return this.world;
  }

  /**
   * Configura el manejador de contactos/colisiones
   */
  private setupContactHandler(): void {
    this.world.addEventListener('beginContact', (event: CANNON.CollisionEvent) => {
      const bodyA = event.bodyA;
      const bodyB = event.bodyB;

      // Disparar eventos de colisión
      // TODO: Implementar sistema de eventos
    });

    this.world.addEventListener('endContact', (event: CANNON.CollisionEvent) => {
      const bodyA = event.bodyA;
      const bodyB = event.bodyB;

      // Manejar fin de colisión
      // TODO: Implementar sistema de eventos
    });
  }
}
