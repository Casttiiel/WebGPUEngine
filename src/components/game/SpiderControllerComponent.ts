import { vec3, quat } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_LEGS = 8;

/**
 * Step group per leg (0-3). A leg only steps if no leg in its group is mid-step.
 * Pairs are diagonal opposites so the two legs that share a group are maximally
 * separated on the body, keeping the spider balanced:
 *   group 0 → FR (0) + MBL (5)
 *   group 1 → FL (1) + MBR (4)
 *   group 2 → MFR(2) + BL  (7)
 *   group 3 → MFL(3) + BR  (6)
 */
const STEP_GROUP: number[] = [0, 1, 2, 3, 1, 0, 3, 2];

/**
 * Metachronal wave: per-leg tick index (0-7) that controls the initial
 * stagger so the spider starts walking with a natural gait.
 *
 * Rule: right side steps back-to-front at EVEN ticks (0,2,4,6),
 *       left side steps back-to-front at ODD  ticks (1,3,5,7).
 * This perfectly interleaves the two sides so no two ipsilateral-adjacent
 * legs are ever in the air at the same time.
 *
 *   tick 0: BR  (6) — right back
 *   tick 1: BL  (7) — left  back
 *   tick 2: MBR (4) — right mid-back
 *   tick 3: MBL (5) — left  mid-back
 *   tick 4: MFR (2) — right mid-front
 *   tick 5: MFL (3) — left  mid-front
 *   tick 6: FR  (0) — right front
 *   tick 7: FL  (1) — left  front
 */
const STEP_INIT_TICK: number[] = [6, 7, 4, 5, 2, 3, 0, 1];

/** Time between consecutive ticks in the initial metachronal wave.
 *  Derived from the default stepDuration (0.16 * 1.1 ≈ 0.176 s). Computed inline as
 *  `this.stepDuration * 1.1` so it adapts when stepDuration is changed at runtime. */

/** Minimum pause (seconds) between two consecutive steps of the same leg. */
const STEP_MIN_COOLDOWN = 0.05;

/** Hip joint attachment points in body-local space. */
const HIP_LOCAL: [number, number, number][] = [
  [+0.42, -0.04, +0.48], // 0 front-right
  [-0.42, -0.04, +0.48], // 1 front-left
  [+0.42, -0.04, +0.14], // 2 midfront-right
  [-0.42, -0.04, +0.14], // 3 midfront-left
  [+0.42, -0.04, -0.14], // 4 midback-right
  [-0.42, -0.04, -0.14], // 5 midback-left
  [+0.42, -0.04, -0.48], // 6 back-right
  [-0.42, -0.04, -0.48], // 7 back-left
];

/** Natural foot rest positions in body-local space (idle stance). */
const FOOT_REST_LOCAL: [number, number, number][] = [
  [+1.05, -0.55, +0.85], // 0
  [-1.05, -0.55, +0.85], // 1
  [+1.25, -0.55, +0.22], // 2
  [-1.25, -0.55, +0.22], // 3
  [+1.25, -0.55, -0.22], // 4
  [-1.25, -0.55, -0.22], // 5
  [+1.05, -0.55, -0.85], // 6
  [-1.05, -0.55, -0.85], // 7
];

/** Lateral outward hint for the knee bend direction (+X = right leg, -X = left leg). */
const KNEE_HINT: [number, number, number][] = [
  [+1, 0.5, 0],
  [-1, 0.5, 0],
  [+1, 0.5, 0],
  [-1, 0.5, 0],
  [+1, 0.5, 0],
  [-1, 0.5, 0],
  [+1, 0.5, 0],
  [-1, 0.5, 0],
];

const TURN_SPEED = 2.5; // rad/s
const GRAVITY = 9.8;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LegState {
  /** Current world position of the planted foot. */
  planted: vec3;
  /** True while a step arc animation is in progress. */
  stepping: boolean;
  /** 0→1 normalised step progress. */
  stepT: number;
  stepFrom: vec3;
  stepTo: vec3;
  upperTx: TransformComponent;
  lowerTx: TransformComponent;
  /** Seconds remaining before this leg may begin a new step. */
  cooldown: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * SpiderControllerComponent
 *
 * Drives a spider-like enemy with procedural IK legs:
 *
 *   M1 — Static IK geometry (legs visible in rest stance)
 *   M2 — Legs track rest positions as the body moves
 *   M3 — Step system: feet lift and replant when displaced (staggered groups)
 *   AI — Simple patrol + player chase
 *
 * Required sibling components:
 *   capsule_collider (kinematic)
 *
 * Required child entities (in order):
 *   Leg0_Upper … Leg7_Upper  (transform + render)
 *   Leg0_Lower … Leg7_Lower  (transform + render)
 */
export class SpiderControllerComponent extends Component {
  private capsule: CapsuleColliderComponent | null = null;
  private characterController: RAPIER.KinematicCharacterController | null = null;

  private legs: LegState[] = [];
  private legsInitialized: boolean = false;
  // Cached body TransformComponent — set once in initLegs().
  private bodyTx: TransformComponent | null = null;
  // Cached body world scale — set once in initLegs(), never changes.
  private bodyScale: vec3 = vec3.fromValues(1, 1, 1);

  // Movement state
  private currentYaw: number = 0;
  private desiredYaw: number = 0;
  private verticalVelocity: number = 0;
  private isGrounded: boolean = false;

  // AI state
  private spawnPos: vec3 = vec3.create();
  private patrolTarget: vec3 = vec3.create();
  private playerEntityId: number = -1;

  // ─── Configurable parameters (exposed via renderInMenu) ──────────────────
  private _editorFolder: any = null;
  private legUpperLength: number = 0.55;
  private legLowerLength: number = 0.5;
  private legThickness: number = 0.06;
  private stepThreshold: number = 0.55;
  private stepDuration: number = 0.16;
  private stepHeight: number = 0.2;
  private stepAnticipation: number = 1.1;
  /** Multiplier applied to the XZ components of each foot rest position.
   *  Values > 1 spread the legs wider / farther from the body. */
  private footSpread: number = 1.0;
  private moveSpeed: number = 1.8;
  private chaseRange: number = 14.0;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  public load(_data: unknown): void {}

  public override async onAttach(): Promise<void> {
    this.capsule = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent | null;
    if (!this.capsule) {
      console.error('SpiderControllerComponent: requires CapsuleColliderComponent');
      return;
    }

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();

    const t = this.capsule.getRigidBody().translation();
    vec3.set(this.spawnPos, t.x, t.y, t.z);
    this.pickPatrolTarget();
    // Leg children are not yet loaded at onAttach time — they are initialized
    // lazily on the first update() call (see initLegs).
  }

  /** Called once on the first update(), after all children are guaranteed loaded. */
  private initLegs(): void {
    // Cache body TransformComponent and world scale (scale is constant).
    this.bodyTx = this.getOwner().getComponent('transform') as TransformComponent;
    vec3.copy(this.bodyScale, this.bodyTx.getTransform().getWorldScale());

    const childByName = new Map<string, TransformComponent>();
    for (const child of this.getOwner().getChildren()) {
      const tx = child.getComponent('transform') as TransformComponent | null;
      if (tx) childByName.set(child.getName(), tx);
    }

    const bodyWorldPos = this.bodyTx.getTransform().getWorldPosition();
    const bodyWorldRot = this.bodyTx.getTransform().getWorldRotation();

    for (let i = 0; i < NUM_LEGS; i++) {
      const upper = childByName.get(`Leg${i}_Upper`);
      const lower = childByName.get(`Leg${i}_Lower`);
      if (!upper || !lower) {
        console.warn(`SpiderControllerComponent: missing leg ${i} child transforms`);
        continue;
      }

      // Initial planted foot = rest in body-local → world.
      // Use the TRS world-matrix formula: worldOff = rot * (scale ⊗ local)  (scale FIRST).
      // This must match the body mesh rendering (mat4.fromRotationTranslationScale).
      const rawRest = FOOT_REST_LOCAL[i]!;
      const restLocal = vec3.fromValues(
        rawRest[0] * this.footSpread,
        rawRest[1],
        rawRest[2] * this.footSpread,
      );
      const restScaled = vec3.multiply(vec3.create(), restLocal, this.bodyScale);
      const planted = vec3.add(
        vec3.create(),
        bodyWorldPos,
        vec3.transformQuat(vec3.create(), restScaled, bodyWorldRot),
      );

      // Stagger initial cooldowns using the metachronal wave tick index.
      // This ensures the spider starts walking with alternating right/left,
      // back-to-front leg waves rather than all stepping at once.
      const initialCooldown = STEP_INIT_TICK[i]! * (this.stepDuration * 1.1);

      this.legs.push({
        planted,
        stepping: false,
        stepT: 0,
        stepFrom: vec3.clone(planted),
        stepTo: vec3.clone(planted),
        upperTx: upper,
        lowerTx: lower,
        cooldown: initialCooldown,
      });
    }

    this.legsInitialized = true;

    // Warm the player entity cache so the first update() doesn't pay the
    // linear scan cost. Safe here since all entities are loaded before the
    // game loop starts.
    this.resolvePlayerPos();
  }

  // ─── Main update ────────────────────────────────────────────────────────────

  public update(dt: number): void {
    if (!this.capsule || !this.characterController) return;
    if (!this.legsInitialized) this.initLegs();
    if (this.legs.length === 0) return;

    const rb = this.capsule.getRigidBody();
    const pos = rb.translation();
    const bodyPos = vec3.fromValues(pos.x, pos.y, pos.z);

    // ── AI: compute desired move direction ──────────────────────────────────
    const desiredDir = vec3.create();
    let speed = this.moveSpeed;

    const playerPos = this.resolvePlayerPos();
    if (playerPos !== null && vec3.dist(bodyPos, playerPos) < this.chaseRange) {
      const toPlayer = vec3.subtract(vec3.create(), playerPos, bodyPos);
      toPlayer[1] = 0;
      const d = vec3.len(toPlayer);
      if (d > 0.6) {
        vec3.scale(desiredDir, toPlayer, 1 / d);
        this.desiredYaw = Math.atan2(desiredDir[0], desiredDir[2]);
      } else {
        speed = 0;
      }
    } else {
      const toPatrol = vec3.subtract(vec3.create(), this.patrolTarget, bodyPos);
      toPatrol[1] = 0;
      const d = vec3.len(toPatrol);
      if (d < 1.0) {
        this.pickPatrolTarget();
      } else {
        vec3.scale(desiredDir, toPatrol, 1 / d);
        this.desiredYaw = Math.atan2(desiredDir[0], desiredDir[2]);
      }
    }

    // ── Smooth yaw toward desired ────────────────────────────────────────────
    let dyaw = this.desiredYaw - this.currentYaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    this.currentYaw += Math.sign(dyaw) * Math.min(Math.abs(dyaw), TURN_SPEED * dt);

    const bodyRot = quat.fromEuler(quat.create(), 0, this.currentYaw * (180 / Math.PI), 0);
    rb.setRotation({ x: bodyRot[0], y: bodyRot[1], z: bodyRot[2], w: bodyRot[3] }, true);
    // Sync bodyRot into the body's TransformComponent NOW, before transform.update()
    // cascades the hierarchy. capsule_collider.update() already ran this frame and wrote
    // the *previous* frame's rotation — override it with the rotation we actually use
    // for IK so the parent→child world transform is consistent.
    this.bodyTx?.getTransform().setLocalRotation(bodyRot);

    // ── Physics movement via character controller ───────────────────────────
    const hit = this.capsule.raycastGrounded(0.2);
    this.isGrounded = hit !== null;

    if (this.isGrounded && this.verticalVelocity < 0) {
      this.verticalVelocity = -0.5;
    } else {
      this.verticalVelocity -= GRAVITY * dt;
    }

    const movement = new RAPIER.Vector3(
      desiredDir[0] * speed * dt,
      this.verticalVelocity * dt,
      desiredDir[2] * speed * dt,
    );
    this.characterController.computeColliderMovement(
      this.capsule.getCollider(),
      movement,
      QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const corrected = this.characterController.computedMovement();
    rb.setLinvel({ x: corrected.x / dt, y: corrected.y / dt, z: corrected.z / dt }, true);

    // ── Procedural legs ─────────────────────────────────────────────────────
    // Pass the desired horizontal velocity so steps can anticipate movement.
    const bodyVelocity = vec3.fromValues(desiredDir[0] * speed, 0, desiredDir[2] * speed);
    this.updateSteps(dt, bodyPos, bodyRot, this.bodyScale, bodyVelocity);
    this.updateLegSegments(bodyPos, bodyRot, this.bodyScale);
  }

  // ─── Step system ────────────────────────────────────────────────────────────

  private updateSteps(
    dt: number,
    bodyPos: vec3,
    bodyRot: quat,
    bodyScale: vec3,
    velocity: vec3,
  ): void {
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i]!;

      // Decrement per-leg cooldown every frame.
      if (leg.cooldown > 0) leg.cooldown -= dt;

      if (leg.stepping) {
        // Advance step arc.
        leg.stepT = Math.min(1, leg.stepT + dt / this.stepDuration);
        const t = this.easeInOut(leg.stepT);
        vec3.lerp(leg.planted, leg.stepFrom, leg.stepTo, t);
        leg.planted[1] += Math.sin(t * Math.PI) * this.stepHeight;
        if (leg.stepT >= 1.0) {
          leg.stepping = false;
          vec3.copy(leg.planted, leg.stepTo);
          leg.cooldown = STEP_MIN_COOLDOWN;
        }
        continue;
      }

      // Current body-relative rest position in world space.
      // TRS world-matrix formula: worldOff = rot * (scale ⊗ local)  (scale FIRST).
      const rawRest = FOOT_REST_LOCAL[i]!;
      const restLocal = vec3.fromValues(
        rawRest[0] * this.footSpread,
        rawRest[1],
        rawRest[2] * this.footSpread,
      );
      const restScaled = vec3.multiply(vec3.create(), restLocal, bodyScale);
      const restWorld = vec3.add(
        vec3.create(),
        bodyPos,
        vec3.transformQuat(vec3.create(), restScaled, bodyRot),
      );

      // Only run distance check (and potentially expensive raycast) when the
      // foot is already close to the trigger radius — cheap early-out.
      if (vec3.dist(leg.planted, restWorld) <= this.stepThreshold * 0.8) continue;

      // Trigger a step if within cooldown, group is free, and foot is displaced.
      if (leg.cooldown > 0) continue;
      if (this.isGroupStepping(STEP_GROUP[i]!)) continue;
      if (vec3.dist(leg.planted, restWorld) <= this.stepThreshold) continue;

      // ── Step target: anticipate where the rest position will be once the
      //    step animation finishes (stepDuration * stepAnticipation seconds).
      //    This makes the foot plant *ahead* of the body when walking.
      const anticipation = vec3.scale(
        vec3.create(),
        velocity,
        this.stepDuration * this.stepAnticipation,
      );
      const stepTo = vec3.add(vec3.create(), restWorld, anticipation);

      // Snap the anticipated landing spot to the ground.
      const groundY = this.getGroundY(stepTo);
      if (groundY !== null) stepTo[1] = groundY;

      leg.stepping = true;
      leg.stepT = 0;
      vec3.copy(leg.stepFrom, leg.planted);
      vec3.copy(leg.stepTo, stepTo);
    }
  }

  /** Returns true if any leg in the given group is currently mid-step. */
  private isGroupStepping(group: number): boolean {
    for (let i = 0; i < this.legs.length; i++) {
      if (STEP_GROUP[i] === group && this.legs[i]!.stepping) return true;
    }
    return false;
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  // ─── IK + segment placement ─────────────────────────────────────────────────

  private updateLegSegments(bodyPos: vec3, bodyRot: quat, bodyScale: vec3): void {
    const invBodyRot = quat.invert(quat.create(), bodyRot);
    const invBodyScale = vec3.fromValues(1 / bodyScale[0], 1 / bodyScale[1], 1 / bodyScale[2]);

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i]!;

      // Hip in world space.
      // TRS world-matrix formula: worldOff = rot * (scale ⊗ local)  (scale FIRST).
      // Matches the body mesh rendering so the attachment point aligns visually.
      const hipScaled = vec3.multiply(vec3.create(), vec3.fromValues(...HIP_LOCAL[i]!), bodyScale);
      const hipWorld = vec3.add(
        vec3.create(),
        bodyPos,
        vec3.transformQuat(vec3.create(), hipScaled, bodyRot),
      );

      // Rotate the body-local knee hint into world space.
      const hintLocal = vec3.fromValues(...KNEE_HINT[i]!);
      const hintWorld = vec3.transformQuat(vec3.create(), hintLocal, bodyRot);

      const footWorld = leg.planted;
      const kneeWorld = this.solveTwoBoneIK(
        hipWorld,
        footWorld,
        this.legUpperLength,
        this.legLowerLength,
        hintWorld,
      );

      this.placeSegment(
        leg.upperTx,
        hipWorld,
        kneeWorld,
        this.legThickness,
        bodyPos,
        invBodyRot,
        invBodyScale,
      );
      this.placeSegment(
        leg.lowerTx,
        kneeWorld,
        footWorld,
        this.legThickness,
        bodyPos,
        invBodyRot,
        invBodyScale,
      );
    }
  }

  /**
   * Analytical 2-bone IK using the law of cosines.
   * @param root      Hip joint position (world space).
   * @param target    Foot target position (world space).
   * @param a         Upper leg length.
   * @param b         Lower leg length.
   * @param hint      World-space direction that the knee should bend toward.
   * @returns World-space knee position.
   */
  private solveTwoBoneIK(root: vec3, target: vec3, a: number, b: number, hint: vec3): vec3 {
    const diff = vec3.subtract(vec3.create(), target, root);
    const rawDist = vec3.len(diff);
    // Clamp to reachable range.
    const dist = Math.max(Math.abs(a - b) + 0.001, Math.min(a + b - 0.001, rawDist));

    const dir = rawDist > 0.0001 ? vec3.normalize(vec3.create(), diff) : vec3.fromValues(0, 0, 1);

    // Angle at the root joint (law of cosines).
    const cosA = Math.max(-1, Math.min(1, (a * a + dist * dist - b * b) / (2 * a * dist)));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    // Compute the knee bend plane: hint projected perpendicular to dir.
    const hintN = vec3.normalize(vec3.create(), hint);
    const dotHint = vec3.dot(hintN, dir);
    const perp = vec3.subtract(vec3.create(), hintN, vec3.scale(vec3.create(), dir, dotHint));
    const perpLen = vec3.len(perp);
    if (perpLen < 0.001) {
      // Degenerate: dir parallel to hint — pick a safe fallback perpendicular.
      const fallback = Math.abs(dir[0]) < 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
      const dot2 = vec3.dot(fallback, dir);
      vec3.subtract(perp, fallback, vec3.scale(vec3.create(), dir, dot2));
      vec3.normalize(perp, perp);
    } else {
      vec3.scale(perp, perp, 1 / perpLen);
    }

    // knee = root + dir*(a·cosA) + perp*(a·sinA)
    const knee = vec3.create();
    vec3.scaleAndAdd(knee, root, dir, a * cosA);
    vec3.scaleAndAdd(knee, knee, perp, a * sinA);
    return knee;
  }

  /**
   * Positions a unit_cube child so it forms a rod from `fromWorld` to `toWorld`.
   *
   * The engine's hierarchy is:
   *   worldPos   = parentPos + parentRot * (parentScale ⊗ localPos)
   *   worldRot   = parentRot * localRot
   *   worldScale = parentScale ⊗ localScale
   *
   * We therefore need to invert that to find the correct local transforms:
   *   localPos   = invParentScale ⊗ (invParentRot * (midWorld - parentPos))
   *   localRot   = invParentRot * quatZToWorldDir
   *   localScale = invParentScale ⊗ (thickness, thickness, worldLength)
   */
  private placeSegment(
    tx: TransformComponent,
    fromWorld: vec3,
    toWorld: vec3,
    thickness: number,
    parentPos: vec3,
    invParentRot: quat,
    invParentScale: vec3,
  ): void {
    const diff = vec3.subtract(vec3.create(), toWorld, fromWorld);
    const length = vec3.len(diff);
    if (length < 0.0001) return;

    const worldDir = vec3.normalize(vec3.create(), diff);
    const midWorld = vec3.lerp(vec3.create(), fromWorld, toWorld, 0.5);

    // localPos inversion of: worldOff = (parentRot * localPos) ⊗ parentScale
    // Inverse:  localPos = invParentRot * (worldOff / parentScale)
    // i.e. divide by scale FIRST (component-wise), THEN rotate.
    const midDiff = vec3.subtract(vec3.create(), midWorld, parentPos);
    const scaledDiff = vec3.fromValues(
      midDiff[0] * invParentScale[0],
      midDiff[1] * invParentScale[1],
      midDiff[2] * invParentScale[2],
    );
    const localPos = vec3.transformQuat(vec3.create(), scaledDiff, invParentRot);

    // localRot = invParentRot * worldRot  (worldRot aligns +Z with worldDir)
    const worldRot = this.quatFromZToDir(worldDir);
    const localRot = quat.multiply(quat.create(), invParentRot, worldRot);

    // localScale = invParentScale ⊗ (thickness, thickness, length)
    const localScale = vec3.fromValues(
      thickness * invParentScale[0],
      thickness * invParentScale[1],
      length * invParentScale[2],
    );

    tx.getTransform().setLocalPosition(localPos);
    tx.getTransform().setLocalRotation(localRot);
    tx.getTransform().setLocalScale(localScale);
  }

  /** Quaternion that rotates +Z to point along `dir`. */
  private quatFromZToDir(dir: vec3): quat {
    const dot = dir[2]; // dot([0,0,1], dir)
    if (dot > 0.9999) return quat.create();
    if (dot < -0.9999) return quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI);
    const axis = vec3.cross(vec3.create(), [0, 0, 1], dir);
    vec3.normalize(axis, axis);
    return quat.setAxisAngle(quat.create(), axis, Math.acos(Math.max(-1, Math.min(1, dot))));
  }

  // ─── Physics / terrain helpers ──────────────────────────────────────────────

  /**
   * Raycasts downward from `worldPos` (offset 0.5 m up) to find the ground Y.
   * Returns null if no ground is found within 3 m.
   */
  private getGroundY(worldPos: vec3): number | null {
    const from = vec3.fromValues(worldPos[0], worldPos[1] + 0.5, worldPos[2]);
    const down = vec3.fromValues(0, -1, 0);
    const hit = Engine.getPhysics().raycast(from, down, 3.0);
    if (!hit) return null;
    // toi is the distance along the ray (unit length) → hitY = from.y - toi
    return from[1] - hit.timeOfImpact;
  }

  // ─── AI helpers ─────────────────────────────────────────────────────────────

  private resolvePlayerPos(): vec3 | null {
    const entities = Engine.getEntities().getAllEntities();

    // Try cached id first.
    if (this.playerEntityId >= 0) {
      const cached = entities.find((e) => e.id === this.playerEntityId);
      if (cached) {
        const tx = cached.getComponent('transform') as TransformComponent | null;
        if (tx) return tx.getTransform().getWorldPosition();
      }
    }

    // Scan for any player controller.
    for (const entity of entities) {
      if (entity.hasComponent('player_controller')) {
        this.playerEntityId = entity.id;
        const tx = entity.getComponent('transform') as TransformComponent | null;
        if (tx) return tx.getTransform().getWorldPosition();
      }
    }
    return null;
  }

  private pickPatrolTarget(): void {
    const angle = Math.random() * Math.PI * 2;
    const radius = 3 + Math.random() * 5;
    vec3.set(
      this.patrolTarget,
      this.spawnPos[0] + Math.cos(angle) * radius,
      this.spawnPos[1],
      this.spawnPos[2] + Math.sin(angle) * radius,
    );
  }

  // ─── Boilerplate ────────────────────────────────────────────────────────────

  public override dispose(): void {
    if (this.characterController) {
      Engine.getPhysics().getWorld().removeCharacterController(this.characterController);
      this.characterController = null;
    }
  }

  public renderDebug(): void {}

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Spider Controller');
    this._editorFolder.close();

    this._editorFolder.add(this, 'footSpread', 0.5, 3.0).step(0.05).name('Foot Spread').listen();
    this._editorFolder
      .add(this, 'legUpperLength', 0.1, 2.0)
      .step(0.01)
      .name('Leg Upper Length')
      .listen();
    this._editorFolder
      .add(this, 'legLowerLength', 0.1, 2.0)
      .step(0.01)
      .name('Leg Lower Length')
      .listen();
    this._editorFolder
      .add(this, 'legThickness', 0.01, 0.3)
      .step(0.005)
      .name('Leg Thickness')
      .listen();
    this._editorFolder
      .add(this, 'stepThreshold', 0.1, 2.0)
      .step(0.05)
      .name('Step Threshold')
      .listen();
    this._editorFolder.add(this, 'stepHeight', 0.0, 1.0).step(0.02).name('Step Height').listen();
    this._editorFolder
      .add(this, 'stepDuration', 0.05, 0.5)
      .step(0.01)
      .name('Step Duration')
      .listen();
    this._editorFolder
      .add(this, 'stepAnticipation', 0.0, 3.0)
      .step(0.1)
      .name('Step Anticipation')
      .listen();
    this._editorFolder.add(this, 'moveSpeed', 0.0, 10.0).step(0.1).name('Move Speed').listen();
    this._editorFolder.add(this, 'chaseRange', 1.0, 50.0).step(0.5).name('Chase Range').listen();
  }
}
