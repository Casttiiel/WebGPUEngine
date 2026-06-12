import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { vec3, quat } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { TrailRendererComponent } from '../vfx/TrailRendererComponent';
import { Msg } from '../../core/ecs/Msg';

export type ProjectileComponentData = {
  speed?: number;
  maxRange?: number;
  damage?: number;
  gravity?: number;
  /** Optional tag forwarded in damage messages (e.g. 'blood_explosive', 'bypass_resistance'). */
  sourceTag?: string;
};

export class ProjectileComponent extends Component {
  private speed: number = 80;
  private maxRange: number = 200;
  public damage: number = 25;
  private gravity: number = 0;
  /** Forwarded into Msg.damage — lets WeakPointComponent / resistance logic identify the source. */
  public sourceTag: string | undefined = undefined;

  private readonly direction: vec3 = vec3.create();
  private readonly prevPosition: vec3 = vec3.create();
  private traveledDistance: number = 0;
  private releaseCallback: ((proj: ProjectileComponent) => void) | null = null;
  /** Rigid body of the entity that fired this projectile — excluded from ray casts. */
  private shooterBody: RAPIER.RigidBody | null = null;
  /** Entity that fired this projectile — forwarded as instigator in damage messages. */
  private _instigatorEntity: Entity | null = null;

  /** Returns the live direction vector. Subclasses may mutate it to steer the projectile. */
  protected getDirection(): vec3 {
    return this.direction;
  }

  public load(data: ProjectileComponentData): void {
    this.speed = data.speed ?? 80;
    this.maxRange = data.maxRange ?? 200;
    this.damage = data.damage ?? 25;
    this.gravity = data.gravity ?? 0;
    this.sourceTag = data.sourceTag;
  }

  /**
   * Activate this projectile from the pool.
   * Called by BulletPoolComponent.acquire() → WeaponComponent.
   */
  public fire(
    origin: vec3,
    direction: vec3,
    onRelease: (proj: ProjectileComponent) => void,
    shooterBody?: RAPIER.RigidBody,
    instigator?: Entity,
  ): void {
    this.shooterBody = shooterBody ?? null;
    this._instigatorEntity = instigator ?? null;
    const transform = (
      this.getOwner().getComponent('transform') as TransformComponent
    ).getTransform();
    transform.setLocalPosition(origin);
    transform.markDirty();

    vec3.normalize(this.direction, direction);

    // Rotate bullet mesh to face direction of travel (+Z local → direction world)
    const q = quat.create();
    quat.rotationTo(q, vec3.fromValues(0, 0, 1), this.direction);
    transform.setLocalRotation(q);

    vec3.copy(this.prevPosition, origin);
    this.traveledDistance = 0;
    this.releaseCallback = onRelease;
    this.enabled = true;

    // Reset and activate trail
    const trail = this.getOwner().getComponent('trail_renderer') as TrailRendererComponent | null;
    if (trail) {
      trail.reset();
      trail.enabled = true;
    }
  }

  public update(dt: number): void {
    // enabled guard is already in ObjectManager, but keep here for safety
    if (!this.enabled) return;

    // Optional gravity (e.g. grenades, arrows)
    if (this.gravity > 0) {
      this.direction[1] -= this.gravity * dt;
    }

    const stepDist = this.speed * dt;

    // Sweep test: cast ray from previous position along direction for this frame's step
    const world = Engine.getPhysics().getWorld();
    const ray = new RAPIER.Ray(
      { x: this.prevPosition[0], y: this.prevPosition[1], z: this.prevPosition[2] },
      { x: this.direction[0], y: this.direction[1], z: this.direction[2] },
    );

    const hit = world.castRay(
      ray,
      stepDist,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      this.shooterBody ?? undefined,
    );
    if (hit) {
      const hitPoint = vec3.scaleAndAdd(
        vec3.create(),
        this.prevPosition,
        this.direction,
        hit.timeOfImpact,
      );
      this.onHit(hitPoint, hit);
      return;
    }

    // Advance position
    const newPos = vec3.scaleAndAdd(vec3.create(), this.prevPosition, this.direction, stepDist);
    const transform = (
      this.getOwner().getComponent('transform') as TransformComponent
    ).getTransform();
    transform.setLocalPosition(newPos);
    transform.markDirty();

    vec3.copy(this.prevPosition, newPos);
    this.traveledDistance += stepDist;

    if (this.traveledDistance >= this.maxRange) {
      this.doRelease();
    }
  }

  // Override to react to hits (damage, decals, sounds, etc.)
  protected onHit(_hitPoint: vec3, hit: RAPIER.RayColliderHit): void {
    if (this.damage > 0) {
      const entityId = Engine.getPhysics().getEntityIdFromCollider(hit.collider.handle);
      if (entityId !== undefined) {
        const entity = Engine.getEntities().getEntityById(entityId);
        entity?.sendMsg(
          Msg.damage({ amount: this.damage, instigator: this._instigatorEntity, sourceTag: this.sourceTag }),
        );
      }
    }
    this.doRelease();
  }

  protected doRelease(): void {
    this.shooterBody = null;
    this.releaseCallback?.(this);
  }

  public renderDebug(): void {}
}
