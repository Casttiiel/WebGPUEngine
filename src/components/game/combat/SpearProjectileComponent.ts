import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { vec3, quat } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { HealthComponent } from '../HealthComponent';
import { Msg } from '../../../core/ecs/Msg';
import { CollisionGroups } from '../../../types/CollisionGroups.enum';

// Ray belongs to PROJECTILE, can only hit ENVIRONMENT and ENEMY — player is invisible to it.
const SPEAR_RAYCAST_GROUPS =
  ((CollisionGroups.PROJECTILE & 0xffff) << 16) |
  ((CollisionGroups.ENVIRONMENT | CollisionGroups.ENEMY) & 0xffff);

export const SPEAR_PARK_POSITION = vec3.fromValues(0, -1000, 0);

export type SpearHitCallback = (hitPoint: vec3) => void;
export type SpearPickedUpCallback = () => void;

export type SpearProjectileData = {
  /** Initial throw speed (units/s). Default: 30. */
  speed?: number;
  /** Gravity applied to velocity while flying (units/s²). Default: 16. */
  gravity?: number;
  /** Air resistance per second while flying — higher = shorter range. Default: 0.4. */
  airFriction?: number;
  /** Max travel distance before the spear auto-recalls to the player (units). Default: 50. */
  maxRange?: number;
  /** Damage dealt on first contact. Default: 20. */
  damage?: number;
  /** Distance from the player at which auto-pickup triggers (units). Default: 1.8. */
  pickupRadius?: number;

  // ── Return (GoW-axe feel) ──────────────────────────────────────────────────
  /** Seconds of windup pause before the spear starts flying back. Default: 0.12. */
  returnDelay?: number;
  /** Speed at the start of the return flight (units/s). Default: 5. */
  returnStartSpeed?: number;
  /** Rate at which the return speed ramps up (units/s²). Default: 140. */
  returnAcceleration?: number;
  /** Max return speed (units/s). Default: 65. */
  returnMaxSpeed?: number;
  /**
   * Amplitude of the random arc during return — how many units to the side the
   * spear drifts at peak. Diminishes as it nears the player. Default: 1.5.
   */
  returnArcAmplitude?: number;
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
 *   FLYING    → Ballistic arc (gravity applied per-frame); embeds on first contact.
 *   EMBEDDED  → Stuck at impact point; waits for proximity pickup or recall (R).
 *   RETURNING → GoW-axe style return: brief windup → slow start → rapid acceleration
 *               with a spin on its own axis.
 */
export class SpearProjectileComponent extends Component {
  // ── Config ─────────────────────────────────────────────────────────────────
  private speed: number = 30;
  private gravity: number = 3;
  private airFriction: number = 0.4;
  private maxRange: number = 50;
  private damage: number = 20;
  private pickupRadius: number = 1.8;

  private returnDelay: number = 0.12;
  private returnStartSpeed: number = 5;
  private returnAcceleration: number = 140;
  private returnMaxSpeed: number = 65;

  // ── Runtime state ──────────────────────────────────────────────────────────
  private state: SpearState = SpearState.PARKED;

  /** Live velocity vector while FLYING (magnitude = current speed). */
  private readonly velocity: vec3 = vec3.create();
  private readonly prevPosition: vec3 = vec3.create();
  private traveledDistance: number = 0;
  private autoRecallTarget: (() => vec3) | null = null;

  private returnCurrentSpeed: number = 0;
  private returnDelayTimer: number = 0;
  private returnArcAmplitude: number = 1.5;
  private readonly returnArcDir: vec3 = vec3.create();
  private returnInitialDist: number = 0;
  private readonly returnStartPos: vec3 = vec3.create();
  private returnTravelProgress: number = 0;

  private onHitCallback: SpearHitCallback | null = null;
  private onPickedUpCallback: SpearPickedUpCallback | null = null;
  private returnTarget: (() => vec3) | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: SpearProjectileData): void {
    this.speed = data.speed ?? 30;
    this.gravity = data.gravity ?? 2;
    this.airFriction = data.airFriction ?? 0.1;
    this.maxRange = data.maxRange ?? 50;
    this.damage = data.damage ?? 20;
    this.pickupRadius = data.pickupRadius ?? 1.8;
    this.returnDelay = data.returnDelay ?? 0.12;
    this.returnStartSpeed = data.returnStartSpeed ?? 5;
    this.returnAcceleration = data.returnAcceleration ?? 140;
    this.returnMaxSpeed = data.returnMaxSpeed ?? 65;
    this.returnArcAmplitude = data.returnArcAmplitude ?? 1.5;
    // Start parked — SpearThrowSystem will call fire() when needed.
    this.enabled = false;
  }

  // ── API (called by SpearThrowSystem) ───────────────────────────────────────

  public fire(
    origin: vec3,
    direction: vec3,
    getRecallTarget: () => vec3,
    onHit: SpearHitCallback,
    onPickedUp: SpearPickedUpCallback,
  ): void {
    this.state = SpearState.FLYING;
    this.autoRecallTarget = getRecallTarget;
    this.onHitCallback = onHit;
    this.onPickedUpCallback = onPickedUp;
    this.traveledDistance = 0;

    // Velocity = aim direction * initial speed
    const dir = vec3.normalize(vec3.create(), direction);
    vec3.scale(this.velocity, dir, this.speed);
    vec3.copy(this.prevPosition, origin);

    const t = this.getTransform();
    t.setLocalPosition(origin);
    t.setLocalRotation(quat.rotationTo(quat.create(), vec3.fromValues(0, 0, 1), dir));
    t.markDirty();

    this.enabled = true;
  }

  /**
   * GoW-axe style recall: brief windup then rapid accelerating return.
   * No-op if not currently embedded.
   */
  public startRecall(getTarget: () => vec3): void {
    if (this.state !== SpearState.EMBEDDED) return;
    this.initReturn(getTarget, true);
  }

  /**
   * Shared return initializer. withDelay=true adds the GoW windup pause;
   * false is used for auto-recall on max-range (already in motion, no pause needed).
   */
  private initReturn(getTarget: () => vec3, withDelay: boolean): void {
    this.state = SpearState.RETURNING;
    this.returnTarget = getTarget;
    this.returnDelayTimer = withDelay ? this.returnDelay : 0;
    this.returnCurrentSpeed = this.returnStartSpeed;
    this.returnTravelProgress = 0;

    const spearPos = this.getTransform().getWorldPosition();
    vec3.copy(this.returnStartPos, spearPos);

    const target = getTarget();
    const toTarget = vec3.subtract(vec3.create(), target, spearPos);
    this.returnInitialDist = vec3.length(toTarget);

    if (this.returnInitialDist > 0.01) {
      const toTargetNorm = vec3.scale(vec3.create(), toTarget, 1 / this.returnInitialDist);
      const rand = vec3.normalize(
        vec3.create(),
        vec3.fromValues(
          (Math.random() - 0.5) * 2,
          Math.abs(Math.random()) + 0.2,
          (Math.random() - 0.5) * 2,
        ),
      );
      const proj = vec3.dot(rand, toTargetNorm);
      vec3.scaleAndAdd(this.returnArcDir, rand, toTargetNorm, -proj);
      vec3.normalize(this.returnArcDir, this.returnArcDir);
    } else {
      vec3.set(this.returnArcDir, 0, 0, 0);
    }
  }

  /** Auto-pickup when the player walks close enough. */
  public tryAutoPickup(playerPos: vec3): boolean {
    if (this.state !== SpearState.EMBEDDED) return false;
    const spearPos = this.getTransform().getWorldPosition();
    if (vec3.distance(playerPos, spearPos) <= this.pickupRadius) {
      this.park();
      return true;
    }
    return false;
  }

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
    // Air friction: exponential velocity decay (slows over distance)
    vec3.scale(this.velocity, this.velocity, Math.exp(-this.airFriction * dt));
    // Gravity
    this.velocity[1] -= this.gravity * dt;

    const currentSpeed = vec3.length(this.velocity);
    if (currentSpeed < 0.5) {
      this.embed(vec3.clone(this.prevPosition));
      return;
    }

    const velDir = vec3.scale(vec3.create(), this.velocity, 1 / currentSpeed);
    const stepDist = currentSpeed * dt;

    const world = Engine.getPhysics().getWorld();
    const hit = world.castRay(
      new RAPIER.Ray(
        { x: this.prevPosition[0], y: this.prevPosition[1], z: this.prevPosition[2] },
        { x: velDir[0], y: velDir[1], z: velDir[2] },
      ),
      stepDist,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      SPEAR_RAYCAST_GROUPS,
    );

    const t = this.getTransform();

    if (hit) {
      const hitPoint = vec3.scaleAndAdd(vec3.create(), this.prevPosition, velDir, hit.timeOfImpact);
      t.setLocalPosition(hitPoint);
      t.setLocalRotation(quat.rotationTo(quat.create(), vec3.fromValues(0, 0, 1), velDir));
      t.markDirty();
      this.handleHit(hitPoint, hit);
      return;
    }

    const newPos = vec3.scaleAndAdd(vec3.create(), this.prevPosition, velDir, stepDist);
    t.setLocalPosition(newPos);
    // Nose follows actual trajectory (tips down as gravity takes over)
    t.setLocalRotation(quat.rotationTo(quat.create(), vec3.fromValues(0, 0, 1), velDir));
    t.markDirty();

    vec3.copy(this.prevPosition, newPos);
    this.traveledDistance += stepDist;

    if (this.traveledDistance >= this.maxRange && this.autoRecallTarget) {
      this.initReturn(this.autoRecallTarget, false);
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
    const cb = this.onHitCallback;
    this.onHitCallback = null;
    cb?.(position);
  }

  // ── Private: RETURNING ────────────────────────────────────────────────────
  // GoW Leviathan Axe: brief pause → slow start → aggressive acceleration + spin

  private readonly ARRIVAL_THRESHOLD = 1.2;

  private updateReturning(dt: number): void {
    // Windup pause — spear is stationary for returnDelay seconds
    if (this.returnDelayTimer > 0) {
      this.returnDelayTimer -= dt;
      return;
    }

    if (!this.returnTarget) return;

    const target = this.returnTarget();
    const t = this.getTransform();
    const currentPos = t.getWorldPosition();

    // Safety net: if somehow already very close, park
    if (vec3.distance(currentPos, target) <= this.ARRIVAL_THRESHOLD) {
      this.park();
      return;
    }

    // Ramp up speed — starts slow, becomes very fast
    this.returnCurrentSpeed = Math.min(
      this.returnCurrentSpeed + this.returnAcceleration * dt,
      this.returnMaxSpeed,
    );

    // Advance parametric progress along the arc (0 = spear start, 1 = player)
    this.returnTravelProgress += this.returnCurrentSpeed * dt;
    const p = Math.min(this.returnTravelProgress / Math.max(this.returnInitialDist, 0.01), 1.0);

    if (p >= 0.98) {
      this.park();
      return;
    }

    // Parametric arc: lerp(startPos, target, p) + sin(pπ) lateral bulge
    // sin(p*PI) is 0 at p=0 and p=1, peaks at p=0.5 → always arrives exactly at player
    const directPoint = vec3.lerp(vec3.create(), this.returnStartPos, target, p);
    const lateralMag = Math.sin(p * Math.PI) * this.returnArcAmplitude;
    const newPos = vec3.scaleAndAdd(vec3.create(), directPoint, this.returnArcDir, lateralMag);
    t.setLocalPosition(newPos);

    // Nose follows actual travel direction
    const travelDir = vec3.subtract(vec3.create(), newPos, currentPos);
    const travelLen = vec3.length(travelDir);
    if (travelLen > 0.001) {
      t.setLocalRotation(
        quat.rotationTo(
          quat.create(),
          vec3.fromValues(0, 0, 1),
          vec3.scale(travelDir, travelDir, 1 / travelLen),
        ),
      );
    }
    t.markDirty();
  }

  // ── Private: PARKED ────────────────────────────────────────────────────────

  private park(): void {
    this.state = SpearState.PARKED;
    this.returnTarget = null;
    this.autoRecallTarget = null;
    const t = this.getTransform();
    t.setLocalPosition(SPEAR_PARK_POSITION);
    t.markDirty();
    this.enabled = false;
    const cb = this.onPickedUpCallback;
    this.onPickedUpCallback = null;
    cb?.();
  }

  private getTransform() {
    return (this.getOwner().getComponent('transform') as TransformComponent).getTransform();
  }

  public override renderDebug(): void {}

  public override dispose(): void {}
}
