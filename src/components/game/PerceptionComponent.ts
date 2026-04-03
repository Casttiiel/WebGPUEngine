import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { Blackboard } from '../../ai/Blackboard';
import { PerceptionComponentDataType } from '../../types/PerceptionComponentData.type';

/**
 * PerceptionComponent
 *
 * Runs autonomous perception checks (hearing + sight) and writes results
 * into the sibling EnemyControllerComponent's Blackboard each tick.
 *
 * Blackboard keys written:
 *  - 'canSeePlayer'    → boolean
 *  - 'canHearPlayer'   → boolean
 *  - 'playerPosition'  → vec3 (last known world position — persists after losing sight)
 *  - 'distToPlayer'    → number (always up-to-date straight-line distance)
 *
 * How it works:
 *  1. Hearing  — instant, no LOS. True when dist < hearRadius.
 *  2. Sight    — three-stage:
 *       a. Distance gate  (dist < sightRadius)
 *       b. FOV cone gate  (angle to player < fovDegrees / 2)
 *       c. LOS raycast    (Rapier castRay excluding BOTH own and player colliders;
 *                          clear LOS = ray reaches player with no hit in between)
 *
 * NOTE — eyeHeightOffset is relative to the rigid body center (capsule midpoint),
 * NOT the ground. For a 1.8m capsule (center at ~0.9m from ground), an offset of
 * 0.7 places the eye at ~1.6m from ground — a natural eye level.
 *
 * Checks are throttled to `checkInterval` seconds (default 0.1 = 10 Hz).
 *
 * Required on the same entity:
 *  - EnemyControllerComponent (provides the Blackboard)
 *  - CapsuleColliderComponent  (provides own collider for ray exclusion)
 *
 * JSON example:
 * {
 *   "perception": {
 *     "sightRadius": 20,
 *     "hearRadius": 8,
 *     "fovDegrees": 120,
 *     "eyeHeightOffset": 1.6,
 *     "checkInterval": 0.1
 *   }
 * }
 */
export class PerceptionComponent extends Component {
  // ─── Parameters ────────────────────────────────────────────────────────────
  private sightRadius: number = 20;
  private hearRadius: number = 8;
  private fovCosHalf: number = Math.cos((120 / 2) * (Math.PI / 180)); // pre-computed
  // Offset from rigid body CENTER (capsule midpoint). 0.7 ≈ eye level for a 1.8m capsule.
  private eyeHeightOffset: number = 0.7;
  private checkInterval: number = 0.1;
  private playerComponentKey: string = 'character_controller';

  // ─── Internal ──────────────────────────────────────────────────────────────
  private bb!: Blackboard;
  private ownCollider!: CapsuleColliderComponent;
  private playerEntity: Entity | null = null;
  private playerCollider: CapsuleColliderComponent | null = null;
  private timer: number = 0;
  private prevCanSee: boolean = false;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: PerceptionComponentDataType): void {
    if (data.sightRadius !== undefined) this.sightRadius = data.sightRadius;
    if (data.hearRadius !== undefined) this.hearRadius = data.hearRadius;
    if (data.eyeHeightOffset !== undefined) this.eyeHeightOffset = data.eyeHeightOffset;
    if (data.checkInterval !== undefined) this.checkInterval = data.checkInterval;
    if (data.playerComponentKey !== undefined) this.playerComponentKey = data.playerComponentKey;

    const fov = data.fovDegrees ?? 120;
    this.fovCosHalf = Math.cos((fov / 2) * (Math.PI / 180));
  }

  public override async onAttach(): Promise<void> {
    const enemy = this.getOwner().getComponent('enemy_controller') as EnemyControllerComponent;
    if (!enemy) {
      console.error('PerceptionComponent: requires EnemyControllerComponent on the same entity!');
      return;
    }
    this.bb = enemy.bb;

    this.ownCollider = this.getOwner().getComponent('capsule_collider') as CapsuleColliderComponent;
    if (!this.ownCollider) {
      console.error('PerceptionComponent: requires CapsuleColliderComponent on the same entity!');
    }
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  public update(deltaTime: number): void {
    if (!this.bb || !this.ownCollider) return;

    this.timer += deltaTime;
    if (this.timer < this.checkInterval) return;
    this.timer = 0;

    // Lazily find the player entity once
    if (!this.playerEntity) this.findPlayer();
    if (!this.playerEntity || !this.playerCollider) return;

    this.runChecks();
  }

  // ─── Core logic ────────────────────────────────────────────────────────────

  private runChecks(): void {
    const playerPos = this.getPlayerEyePos();
    const ownPos = this.getOwnEyePos();

    const toPlayer = vec3.subtract(vec3.create(), playerPos, ownPos);
    const dist = vec3.length(toPlayer);

    this.bb.set<number>('distToPlayer', dist);

    // ── Hearing ──────────────────────────────────────────────────────────────
    this.bb.set<boolean>('canHearPlayer', dist <= this.hearRadius);

    // ── Sight: distance gate ─────────────────────────────────────────────────
    if (dist > this.sightRadius) {
      if (this.prevCanSee) this.prevCanSee = false;
      this.bb.set<boolean>('canSeePlayer', false);
      return;
    }

    // ── Sight: FOV cone gate ─────────────────────────────────────────────────
    const facing = this.bb.get<vec3>('facing', vec3.fromValues(0, 0, 1));
    const dirToPlayer = vec3.normalize(vec3.create(), toPlayer);
    const dot = vec3.dot(facing, dirToPlayer);

    if (dot < this.fovCosHalf) {
      if (this.prevCanSee) this.prevCanSee = false;
      this.bb.set<boolean>('canSeePlayer', false);
      return;
    }

    // ── Sight: Line-of-sight raycast ─────────────────────────────────────────
    const canSee = this.castLOS(ownPos, dirToPlayer, dist);
    this.bb.set<boolean>('canSeePlayer', canSee);

    if (canSee && !this.prevCanSee) {
      // First detection — mark that we have a last-known position to investigate
      this.bb.set<boolean>('hasLastKnown', true);
    }
    this.prevCanSee = canSee;

    if (canSee) {
      const stored = this.bb.get<vec3>('playerPosition') ?? vec3.create();
      vec3.copy(stored, this.getPlayerBodyPos());
      this.bb.set('playerPosition', stored);
    }
  }

  /**
   * Casts a ray from enemy eye to player eye.
   * Excludes BOTH the enemy's own collider AND the player's collider.
   * Strategy: if nothing is hit → path is clear → can see.
   *           if something IS hit → a wall/object blocks the LOS.
   * This avoids entity-ID lookups and is robust against sensors / triggers.
   */
  private castLOS(origin: vec3, direction: vec3, maxDist: number): boolean {
    const world = Engine.getPhysics().getWorld();

    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );

    // Rapier only lets us exclude ONE collider natively.
    // We exclude the enemy's own collider and use a predicate to skip the player.
    const playerCollider = this.playerCollider!.getCollider();
    const hit = world.castRay(
      ray,
      maxDist,
      true, // solid
      QueryFilterFlags.EXCLUDE_SENSORS, // ignore trigger volumes
      undefined, // no interaction group filter
      this.ownCollider.getCollider(), // exclude own capsule
      undefined, // no rigid body exclusion
      (collider) => collider.handle !== playerCollider.handle, // skip player collider
    );

    // No hit → nothing blocked the path → player is visible
    if (hit !== null) {
      const rb = hit.collider.parent();
      console.log(
        `[LOS] BLOCKED  toi=${hit.timeOfImpact.toFixed(2)}m` +
          `  colliderHandle=${hit.collider.handle}` +
          `  rigidBodyType=${rb ? rb.bodyType() : 'unknown'}` +
          `  isSensor=${hit.collider.isSensor()}`,
      );
    }
    return hit === null;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private getOwnEyePos(): vec3 {
    const t = this.ownCollider.getRigidBody().translation();
    return vec3.fromValues(t.x, t.y + this.eyeHeightOffset, t.z);
  }

  private getPlayerEyePos(): vec3 {
    const t = this.playerCollider!.getRigidBody().translation();
    return vec3.fromValues(t.x, t.y + this.eyeHeightOffset, t.z);
  }

  private getPlayerBodyPos(): vec3 {
    const t = this.playerCollider!.getRigidBody().translation();
    return vec3.fromValues(t.x, t.y, t.z);
  }

  /**
   * Searches all entities for the one with a `character_controller` component.
   * Caches the result so this is only called once.
   */
  private findPlayer(): void {
    const entities = Engine.getEntities().getAllEntities();
    for (const entity of entities) {
      if (entity.hasComponent(this.playerComponentKey)) {
        this.playerEntity = entity;
        this.playerCollider = entity.getComponent('capsule_collider') as CapsuleColliderComponent;
        if (!this.playerCollider) {
          console.warn(
            'PerceptionComponent: player entity found but has no CapsuleColliderComponent.',
          );
        }
        return;
      }
    }
  }

  // ─── Component boilerplate ─────────────────────────────────────────────────

  public renderDebug(): void {}
  public override renderInMenu(): void {}
}
