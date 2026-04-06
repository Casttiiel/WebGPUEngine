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

  /**
   * 'indoor'  — AABB is a real room boundary: apply PCC to align reflections with geometry.
   * 'outdoor' — environment is effectively infinite: skip PCC, just use the probe's env cubemap.
   * Default: 'indoor'
   */
  private probeType: 'indoor' | 'outdoor' = 'indoor';

  /** Own pre-baked irradiance cubemap for multi-probe blending. */
  private irradianceCubemap: Cubemap | null = null;

  /** Own pre-baked prefiltered env cubemap for per-probe specular PCC. */
  private envCubemap: Cubemap | null = null;

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
      type?: 'indoor' | 'outdoor';
    };
    this.radius = probeData?.radius ?? 10.0;
    this.resolution = probeData?.resolution ?? 512;
    this.probeType = probeData?.type ?? 'indoor';

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

    // Load own irradiance and env cubemaps for per-probe PCC blending
    const baseName = this.getOwner().getName();
    const [irr, env] = await Promise.all([
      Cubemap.getAsync(baseName + '_irradiance_cubemap_T.png').catch(() => null),
      Cubemap.getAsync(baseName + '_env_cubemap_T.png').catch(() => null),
    ]);
    this.irradianceCubemap = irr;
    this.envCubemap = env;

    // Register with ProbeManager so AmbientLight can drive per-probe PCC
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
    if (entity && entity.hasComponent('character_controller')) {
      this.entitiesInside.add(entityId);
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

  public getExtents(): vec3 {
    return vec3.clone(this.extents);
  }

  public setExtents(e: vec3): void {
    vec3.copy(this.extents, e);
  }

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

  /** Returns the GPU view for this probe's pre-baked irradiance cubemap, or null if not loaded. */
  public getIrradianceView(): GPUTextureView | null {
    return this.irradianceCubemap?.getTextureView() ?? null;
  }

  /** Returns the GPU view for this probe's prefiltered env cubemap (specular PCC), or null if not loaded. */
  public getEnvView(): GPUTextureView | null {
    return this.envCubemap?.getTextureView() ?? null;
  }

  /**
   * Returns the probe mode as a float packed into the w component of probePos uniforms:
   *   0.0 = no probe (handled by caller)
   *   1.0 = outdoor — use probe env, no PCC correction
   *   2.0 = indoor  — use probe env + PCC AABB correction
   */
  public getProbeTypeFlag(): number {
    return this.probeType === 'indoor' ? 2.0 : 1.0;
  }

  public override dispose(): void {
    ProbeManager.getInstance().unregister(this);
    super.dispose();
  }
}
