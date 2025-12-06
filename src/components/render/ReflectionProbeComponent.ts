import { Component } from '../../core/ecs/Component';
import { Camera } from '../../core/math/Camera';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { BoxColliderComponent } from '../physics/BoxColliderComponent';
import { Engine } from '../../core/engine/Engine';

export class ReflectionProbeComponent extends Component {
  private radius: number = 10.0; // Radio de influencia
  private resolution: number = 256; // Resolución del cubemap (512x512 por cara)
  private captureCamera: Camera | null = null;

  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();

  constructor() {
    super();
  }

  public load(data: unknown): void {
    const probeData = data as { radius?: number; resolution?: number };
    this.radius = probeData?.radius ?? 10.0;
    this.resolution = probeData?.resolution ?? 512;

    // Crear cámara de captura con FOV 90° para cubemap
    this.captureCamera = new Camera();
    this.captureCamera.setFov(90); // FOV 90° para cubemap
    this.captureCamera.setViewport(this.resolution, this.resolution); // Aspect 1:1
    this.captureCamera.setNearPlane(0.1);
    this.captureCamera.setFarPlane(1000.0); // Far plane extendido para capturar más escena
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
      console.warn('ReflectionProbe: No se encontró box_collider (necesario para triggers)');
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
      Engine.getEnvironmentManager().changeSSREnvironmentTexture(
        this.getOwner().getName() + '_cubemap_T.png',
      );
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

  public getRadius(): number {
    return this.radius;
  }

  public getResolution(): number {
    return this.resolution;
  }

  public getCaptureCamera(): Camera | null {
    return this.captureCamera;
  }

  public getPosition(): vec3 {
    const transform = this.getOwner().getComponent('transform');
    if (!transform) {
      return vec3.create();
    }
    return (transform as TransformComponent).getTransform().getWorldPosition();
  }

  public getEntitiesInside(): Set<number> {
    return this.entitiesInside;
  }
}
