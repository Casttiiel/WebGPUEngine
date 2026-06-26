import { Component } from '../../core/ecs/Component';
import { Camera } from '../../core/math/Camera';
import { vec3 } from 'gl-matrix';
import { TransformComponent } from '../core/TransformComponent';
import { Engine } from '../../core/engine/Engine';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { SHData } from '../../renderer/resources/SHData';
import { ProbeManager } from '../../renderer/core/managers/ProbeManager';
import { ReflectionProbeComponentData } from '../../types/ReflectionProbeComponentData.type';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import type { IMsg, TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';

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

  /** SH L2 irradiance data loaded from assets/probes/{name}_sh.json. */
  private shData: SHData | null = null;

  /** Own pre-baked prefiltered env cubemap for per-probe specular PCC. */
  private envCubemap: Cubemap | null = null;

  // Tracking de entidades dentro del trigger
  private entitiesInside: Set<number> = new Set();

  constructor() {
    super();
  }

  public load(probeData: ReflectionProbeComponentData): void {
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
    const baseName = this.getOwner().getName();

    // SH is small (~1 KB) and contributes to ambient even from a distance — load eagerly.
    this.shData = SHData.get(`${baseName}_sh.json`);

    // Specular cubemap is large and only needed when the player is inside this probe.
    // Loaded lazily on first onEntityEnter — see below.

    ProbeManager.getInstance().register(this);
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'reflection_probe', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as ReflectionProbeComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'reflection_probe', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as ReflectionProbeComponent).onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('player_controller')) {
      this.entitiesInside.add(entityId);
      this.ensureEnvCubemapLoaded();
    }
  }

  private ensureEnvCubemapLoaded(): void {
    if (this.envCubemap) return;
    const baseName = this.getOwner().getName();
    this.envCubemap = Cubemap.get(`${baseName}_cubemap_T.png`, { baseFolder: 'assets/probes' });
  }

  private onEntityExit(entityId: number): void {
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity && entity.hasComponent('player_controller')) {
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

  /** Returns the 27-float SH L2 irradiance coefficients, or null if not yet loaded. */
  public getSHCoefficients(): Float32Array | null {
    return this.shData?.getCoefficients() ?? null;
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
  public getProbeType(): 'indoor' | 'outdoor' {
    return this.probeType;
  }

  public getProbeTypeFlag(): number {
    return this.probeType === 'indoor' ? 2.0 : 1.0;
  }

  public override dispose(): void {
    ProbeManager.getInstance().unregister(this);
    super.dispose();
  }
}
