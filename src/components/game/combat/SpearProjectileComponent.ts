import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { vec3, quat } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { HealthComponent } from '../HealthComponent';
import { Msg } from '../../../core/ecs/Msg';

export const SPEAR_PARK_POSITION = vec3.fromValues(0, -1000, 0);

export type SpearHitCallback = (hitPoint: vec3) => void;
export type SpearPickedUpCallback = () => void;

export type SpearProjectileData = {
  /** Travel speed (units/s). Default: 30. */
  speed?: number;
  /** Return speed when recalled (units/s). Default: 35. */
  returnSpeed?: number;
  /** Damage dealt on first contact. Default: 20. */
  damage?: number;
  /** Max travel distance before embedding in place (units). Default: 50. */
  maxRange?: number;
  /** Distance from the player at which auto-pickup triggers (units). Default: 1.5. */
  pickupRadius?: number;
};

const enum SpearState {
  PARKED = 0,
  FLYING = 1,
  EMBEDDED = 2,
  RETURNING = 3,
}

/**
 * SpearProjectileComponent — Single-instance throwing weapon for Lynx.
 *
 * State machine:
 *   PARKED    → Entity is underground, component is disabled.
 *   FLYING    → In flight; raycasted movement each frame; damages + embeds on first contact.
 *   EMBEDDED  → Stuck at impact point; waits for auto-pickup (proximity) or recall (R).
 *   RETURNING → Flying back toward the player; parks and notifies when arrived.
 *
 * Managed externally by SpearThrowSystem, which owns the input handling.
 */
export class SpearProjectileComponent extends Component {
  private speed: number = 30;
  private returnSpeed: number = 35;
  private damage: number = 20;
  private maxRange: number = 50;
  private pickupRadius: number = 1.5;

  private state: SpearState = SpearState.PARKED;

  private readonly direction: vec3 = vec3.create();
  private readonly prevPosition: vec3 = vec3.create();
  private traveledDistance: number = 0;
  private shooterBody: RAPIER.RigidBody | null = null;

  private onHitCallback: SpearHitCallback | null = null;
  private onPickedUpCallback: SpearPickedUpCallback | null = null;
  private returnTarget: (() => vec3) | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: SpearProjectileData): void {
    this.speed = data.speed ?? 30;
    this.returnSpeed = data.returnSpeed ?? 35;
    this.damage = data.damage ?? 20;
    this.maxRange = data.maxRange ?? 50;
    this.pickupRadius = data.pickupRadius ?? 1.5;
    // Start parked — SpearThrowSystem will call fire() when needed.
    this.enabled = false;
  }

  // ── API (called by SpearThrowSystem) ───────────────────────────────────────

  /**
   * Launch the spear from origin along direction.
   * @param onHit     Called when the spear embeds (hit point in world space).
   * @param onPickedUp Called when the spear returns to the player (either pickup or recall).
   */
  public fire(
    origin: vec3,
    direction: vec3,
    shooterBody: RAPIER.RigidBody | null,
    onHit: SpearHitCallback,
    onPickedUp: SpearPickedUpCallback,
  ): void {
    this.state = SpearState.FLYING;
    this.shooterBody = shooterBody;
    this.onHitCallback = onHit;
    this.onPickedUpCallback = onPickedUp;
    this.traveledDistance = 0;

    vec3.normalize(this.direction, direction);
    vec3.copy(this.prevPosition, origin);

    const t = (this.getOwner().getComponent('transform') as TransformComponent).getTransform();
    t.setLocalPosition(origin);
    // Orient spear tip along travel direction (local +Z → world direction)
    t.setLocalRotation(quat.rotationTo(quat.create(), vec3.fromValues(0, 0, 1), this.direction));
    t.markDirty();

    this.enabled = true;
  }

  /**
   * Trigger the "Thor's hammer" recall — spear flies back to the player.
   * No-op if the spear is not currently embedded.
   * @param getTarget  Called each frame to get the current player chest position.
   */
  public startRecall(getTarget: () => vec3): void {
    if (this.state !== SpearState.EMBEDDED) return;
    this.state = SpearState.RETURNING;
    this.returnTarget = getTarget;
  }

  /**
   * Check whether the player is close enough to auto-pick up the embedded spear.
   * @returns true if picked up, false otherwise.
   */
  public tryAutoPickup(playerPos: vec3): boolean {
    if (this.state !== SpearState.EMBEDDED) return false;
    const spearPos = (this.getOwner().getComponent('transform') as TransformComponent)
      .getTransform()
      .getWorldPosition();
    if (vec3.distance(playerPos, spearPos) <= this.pickupRadius) {
      this.park();
      return true;
    }
    return false;
  }

  /** True when embedded in the world and available for recall or pickup. */
  public isEmbedded(): boolean {
    return this.state === SpearState.EMBEDDED;
  }

  // ── ECS update ─────────────────────────────────────────────────────────────

  public update(dt: number): void {
    if (this.state === SpearState.FLYING) {
      this.updateFlying(dt);
    } else if (this.state === SpearState.RETURNING) {
      this.updateReturning(dt);
    }
  }

  // ── Private: FLYING ────────────────────────────────────────────────────────

  private updateFlying(dt: number): void {
    const stepDist = this.speed * dt;
    const world = Engine.getPhysics().getWorld();

    const hit = world.castRay(
      new RAPIER.Ray(
        { x: this.prevPosition[0], y: this.prevPosition[1], z: this.prevPosition[2] },
        { x: this.direction[0], y: this.direction[1], z: this.direction[2] },
      ),
      stepDist,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      this.shooterBody ?? undefined,
    );

    const t = (this.getOwner().getComponent('transform') as TransformComponent).getTransform();

    if (hit) {
      const hitPoint = vec3.scaleAndAdd(
        vec3.create(),
        this.prevPosition,
        this.direction,
        hit.timeOfImpact,
      );
      t.setLocalPosition(hitPoint);
      t.markDirty();
      this.handleHit(hitPoint, hit);
      return;
    }

    const newPos = vec3.scaleAndAdd(vec3.create(), this.prevPosition, this.direction, stepDist);
    t.setLocalPosition(newPos);
    t.markDirty();
    vec3.copy(this.prevPosition, newPos);
    this.traveledDistance += stepDist;

    // Embed in place at max range if nothing was hit
    if (this.traveledDistance >= this.maxRange) {
      this.embed(newPos);
    }
  }

  private handleHit(hitPoint: vec3, hit: RAPIER.RayColliderHit): void {
    const entityId = Engine.getPhysics().getEntityIdFromCollider(hit.collider.handle);
    if (entityId !== undefined) {
      const entity = Engine.getEntities().getEntityById(entityId);
      if (entity?.getComponent('health') instanceof HealthComponent) {
        entity.sendMsg(Msg.damage({ amount: this.damage, instigator: null }));
      }
    }
    this.embed(hitPoint);
  }

  private embed(position: vec3): void {
    this.state = SpearState.EMBEDDED;
    this.shooterBody = null;
    const cb = this.onHitCallback;
    this.onHitCallback = null;
    cb?.(position);
  }

  // ── Private: RETURNING ─────────────────────────────────────────────────────

  private readonly ARRIVAL_THRESHOLD = 1.2;

  private updateReturning(dt: number): void {
    if (!this.returnTarget) return;

    const target = this.returnTarget();
    const t = (this.getOwner().getComponent('transform') as TransformComponent).getTransform();
    const currentPos = t.getWorldPosition();

    const toTarget = vec3.subtract(vec3.create(), target, currentPos);
    const dist = vec3.length(toTarget);

    if (dist <= this.ARRIVAL_THRESHOLD) {
      this.park();
      return;
    }

    const stepDist = Math.min(this.returnSpeed * dt, dist);
    vec3.normalize(toTarget, toTarget);

    t.setLocalPosition(vec3.scaleAndAdd(vec3.create(), currentPos, toTarget, stepDist));
    t.setLocalRotation(quat.rotationTo(quat.create(), vec3.fromValues(0, 0, 1), toTarget));
    t.markDirty();
  }

  // ── Private: PARKED ────────────────────────────────────────────────────────

  private park(): void {
    this.state = SpearState.PARKED;
    this.returnTarget = null;
    this.shooterBody = null;
    const t = (this.getOwner().getComponent('transform') as TransformComponent).getTransform();
    t.setLocalPosition(SPEAR_PARK_POSITION);
    t.markDirty();
    this.enabled = false;
    const cb = this.onPickedUpCallback;
    this.onPickedUpCallback = null;
    cb?.();
  }

  public renderDebug(): void {}

  public dispose(): void {}
}
