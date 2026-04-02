import { Component } from '../../core/ecs/Component';
import { Camera } from '../../core/math/Camera';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { BoxColliderComponent } from '../physics/BoxColliderComponent';
import { Engine } from '../../core/engine/Engine';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { ProbeManager } from '../../renderer/core/managers/ProbeManager';

export class ReflectionProbeComponent extends Component {
  private radius: number = 10.0; // Radio de influencia
  private resolution: number = 256; // Resolución del cubemap (512x512 por cara)
  private captureCamera: Camera | null = null;

  /** Half-extents of the probe influence box (x, y, z). Defaults to (radius, radius, radius). */
  private extents: vec3 = vec3.fromValues(10, 10, 10);

  /** Own pre-baked irradiance cubemap for multi-probe blending. */
  private irradianceCubemap: Cubemap | null = null;

  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();

  constructor() {
    super();
  }

  public load(data: unknown): void {
    const probeData = data as {
      radius?: number;
      resolution?: number;
      extents?: [number, number, number];
    };
    this.radius = probeData?.radius ?? 10.0;
    this.resolution = probeData?.resolution ?? 512;

    if (probeData?.extents) {
      vec3.set(this.extents, probeData.extents[0], probeData.extents[1], probeData.extents[2]);
    } else {
      vec3.set(this.extents, this.radius, this.radius, this.radius);
    }

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

    // Load own irradiance cubemap for multi-probe blending
    const irrName = this.getOwner().getName() + '_irradiance_cubemap_T.png';
    this.irradianceCubemap = await Cubemap.getAsync(irrName).catch(() => null);

    // Register with ProbeManager so AmbientLight can blend between probes
    ProbeManager.getInstance().register(this);

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
    const envTextureName = this.getOwner().getName() + '_env_cubemap_T.png';
    const irrTextureName = this.getOwner().getName() + '_irradiance_cubemap_T.png';

    if (
      entity &&
      entity.hasComponent('character_controller') &&
      Engine.getEnvironmentManager().getSSREnvironmentTexture().getName() !== envTextureName &&
      Engine.getEnvironmentManager().getAmbientLightData().irradianceCubemap.getName() !==
        irrTextureName
    ) {
      this.entitiesInside.add(entityId);
      Engine.getEnvironmentManager().changeSSREnvironmentTexture(envTextureName);
      Engine.getEnvironmentManager().changeIrradianceTexture(irrTextureName);
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

  /** Half-extents of the probe influence box (x, y, z). */
  public getExtents(): vec3 {
    return this.extents;
  }

  /** Returns the GPU view for this probe's pre-baked irradiance cubemap, or null if not loaded. */
  public getIrradianceView(): GPUTextureView | null {
    return this.irradianceCubemap?.getTextureView() ?? null;
  }

  public override dispose(): void {
    ProbeManager.getInstance().unregister(this);
    super.dispose();
  }
}
