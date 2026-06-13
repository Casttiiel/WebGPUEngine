import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { Blackboard } from '../../ai/Blackboard';
import { PerceptionComponentDataType } from '../../types/PerceptionComponentData.type';
import { NoiseEventDispatcher } from '../../ai/NoiseEventDispatcher';
import { BasePlayerController } from './BasePlayerController';

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
  private playerComponentKey: string = 'player_controller';
  /**
   * H&S deaggro distance: once the player is spotted, the enemy keeps tracking
   * without FOV or LOS until the player moves farther than this value.
   * Prevents enemies from "losing" the player during normal melee combat.
   */
  private deaggroRadius: number = 25;

  // ─── Internal ──────────────────────────────────────────────────────────────
  /** Tier 2.8 — Reaction delay: pending player position after a large jump. */
  private _pendingPos: vec3 | null = null;
  /** Seconds remaining until _pendingPos is written to the blackboard. */
  private _pendingTimer: number = 0;

  private bb!: Blackboard;
  private ownCollider!: CapsuleColliderComponent;
  private playerEntity: Entity | null = null;
  private playerCollider: CapsuleColliderComponent | null = null;
  private timer: number = 0;
  private prevCanSee: boolean = false;
  /** Cached player controller for state queries (playerInAir, playerIsRetreating). */
  private playerController: BasePlayerController | null = null;
  /** Distance to player in the previous perception check — for retreating detection. */
  private _prevDist: number = 0;
  /**
   * H&S combat state: true once player is first spotted (FOV+LOS).
   * While true, sight check is a simple distance gate (deaggroRadius) — no FOV/LOS.
   * Cleared when player moves beyond deaggroRadius.
   */
  private _inCombat: boolean = false;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public load(data: PerceptionComponentDataType): void {
    if (data.sightRadius !== undefined) this.sightRadius = data.sightRadius;
    if (data.hearRadius !== undefined) this.hearRadius = data.hearRadius;
    if (data.eyeHeightOffset !== undefined) this.eyeHeightOffset = data.eyeHeightOffset;
    if (data.checkInterval !== undefined) this.checkInterval = data.checkInterval;
    if (data.playerComponentKey !== undefined) this.playerComponentKey = data.playerComponentKey;
    if (data.deaggroRadius !== undefined) this.deaggroRadius = data.deaggroRadius;

    const fov = data.fovDegrees ?? 120;
    this.fovCosHalf = Math.cos((fov / 2) * (Math.PI / 180));
  }

  public override async onAttach(): Promise<void> {
    // Accept any EnemyControllerComponent subclass regardless of its component key.
    const enemy = this.getOwner()
      .getAllComponents()
      .find((c) => c instanceof EnemyControllerComponent) as EnemyControllerComponent | undefined;
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

    // Tier 2.8 — flush pending position when reaction delay expires (runs every frame)
    if (this._pendingPos !== null) {
      this._pendingTimer -= deltaTime;
      if (this._pendingTimer <= 0) {
        const stored = this.bb.get<vec3>('playerPosition') ?? vec3.create();
        vec3.copy(stored, this._pendingPos);
        this.bb.set('playerPosition', stored);
        this._pendingPos = null;
      }
    }

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

    // ── Player state — Bloque 4 contextual modifiers ──────────────────────────
    if (this.playerController) {
      // playerInAir: jugador en el aire y cayendo
      const inAir = !this.playerController.getIsGrounded() &&
                    this.playerController.getVerticalVelocity() < -0.5;
      this.bb.set<boolean>('playerInAir', inAir);

      // playerIsRetreating: la distancia aumenta > 1.5 m/s entre checks (10 Hz → > 0.15 m/check)
      const retreating = (dist - this._prevDist) / this.checkInterval > 1.5;
      this.bb.set<boolean>('playerIsRetreating', retreating);
    }
    this._prevDist = dist;

    // ── Hearing — direct distance check ──────────────────────────────────────
    const canHear = dist <= this.hearRadius;
    this.bb.set<boolean>('canHearPlayer', canHear);

    // ── Sight — H&S two-mode check ────────────────────────────────────────────
    // In combat (already spotted): simple deaggro distance check, no FOV/LOS.
    // Not in combat: full 3-stage check. Entering combat stays until deaggro.
    let canSee = false;
    if (this._inCombat) {
      canSee = dist <= this.deaggroRadius;
      if (!canSee) this._inCombat = false; // player escaped → back to patrol
    } else {
      if (dist <= this.sightRadius) {
        const facing = this.bb.get<vec3>('facing', vec3.fromValues(0, 0, 1));
        const dirToPlayer = vec3.normalize(vec3.create(), toPlayer);
        if (vec3.dot(facing, dirToPlayer) >= this.fovCosHalf) {
          canSee = this.castLOS(ownPos, dirToPlayer, dist);
          if (canSee) this._inCombat = true; // first contact → enter combat state
        }
      }
    }

    if (canSee && !this.prevCanSee) {
      this.bb.set<boolean>('hasLastKnown', true);
    }
    this.prevCanSee = canSee;
    this.bb.set<boolean>('canSeePlayer', canSee);

    // ── Position updates — sight > hearing > noise events ────────────────────
    if (canSee) {
      // Tier 2.8 — sight update with reaction delay for large position jumps.
      // If the player dashed/rolled > 3 m, defer the BB update by 0.2–0.8 s
      // so enemies briefly keep chasing the old position (natural reaction lag).
      const newPos = this.getPlayerBodyPos();
      const stored = this.bb.get<vec3>('playerPosition') ?? vec3.create();
      const jump = vec3.distance(stored, newPos);
      if (jump > 3.0 && this._pendingPos === null) {
        this._pendingPos = newPos;
        this._pendingTimer = 0.2 + Math.random() * 0.6; // 0.2–0.8 s delay
      } else if (this._pendingPos === null) {
        // Small move — update immediately as before
        vec3.copy(stored, newPos);
        this.bb.set('playerPosition', stored);
      }
      // While pending: keep old position until _pendingTimer fires
    } else if (canHear) {
      // Hearing: within hearRadius, enemy knows you're here (no LOS needed)
      this.bb.set<boolean>('hasLastKnown', true);
      const stored = this.bb.get<vec3>('playerPosition') ?? vec3.create();
      vec3.copy(stored, this.getPlayerBodyPos());
      this.bb.set('playerPosition', stored);
    } else {
      // Noise events: player or world emitted a sound — investigate the origin
      const noise = NoiseEventDispatcher.getEventsInRange(ownPos, this.hearRadius);
      if (noise.length > 0) {
        let closestDist = Infinity;
        let closestPos: vec3 | null = null;
        for (const ev of noise) {
          const d = vec3.distance(ownPos, ev.position);
          if (d < closestDist) {
            closestDist = d;
            closestPos = ev.position;
          }
        }
        if (closestPos) {
          this.bb.set<boolean>('hasLastKnown', true);
          const stored = this.bb.get<vec3>('playerPosition') ?? vec3.create();
          vec3.copy(stored, closestPos);
          this.bb.set('playerPosition', stored);
        }
      }
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
      /*const rb = hit.collider.parent();
      console.log(
        `[LOS] BLOCKED  toi=${hit.timeOfImpact.toFixed(2)}m` +
          `  colliderHandle=${hit.collider.handle}` +
          `  rigidBodyType=${rb ? rb.bodyType() : 'unknown'}` +
          `  isSensor=${hit.collider.isSensor()}`,
      );*/
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
   * Searches all entities for the one with a `player_controller` component.
   * Caches the result so this is only called once.
   */
  private findPlayer(): void {
    const entities = Engine.getEntities().getAllEntities();
    for (const entity of entities) {
      if (entity.hasComponent(this.playerComponentKey)) {
        this.playerEntity = entity;
        this.playerCollider = entity.getComponent('capsule_collider') as CapsuleColliderComponent;
        this.playerController = entity.getComponent('player_controller') as BasePlayerController | null;
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
