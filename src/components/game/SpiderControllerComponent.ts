import { vec3, quat } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { NameComponent } from '../core/NameComponent';
import { RenderComponent } from '../render/RenderComponent';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum pause (seconds) between two consecutive steps of the same leg. */
const STEP_MIN_COOLDOWN = 0.05;

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
  /** Z-reach multiplier for front legs (indices 0-3). > 1 pushes feet further forward. */
  private frontLegReach: number = 1.0;
  /** Z-reach multiplier for back legs (indices 4-7). > 1 pushes feet further rearward. */
  private backLegReach: number = 1.0;
  // Body bob
  private bodyBobPhase: number = 0;
  private bodyBobAmount: number = 0.04; // metres of vertical oscillation
  private bodyBobSpeed: number = 8.0; // rad/s
  // Body tilt on turn
  private bodyTiltAmount: number = 0.08; // max roll in radians
  private moveSpeed: number = 1.8;
  private chaseRange: number = 14.0;
  /** Mesh path used for each leg segment (unit_cube.obj by default). */
  private legMesh: string = 'unit_cube.obj';
  /** Material path used for each leg segment. */
  private legMaterial: string = 'metal.mat';

  /** Leg child entities spawned by this component (tracked for dispose). */
  private legEntities: Entity[] = [];

  // ─── Per-leg geometry (configurable via JSON + editor) ───────────────────
  /** How many legs. Must equal the number of Leg*_Upper/Lower child pairs. */
  private numLegs: number = 8;
  /** Hip joint attachment points in body-local space (one per leg). */
  private hipLocal: [number, number, number][] = [
    [+0.42, -0.04, +0.48], // 0 FR
    [-0.42, -0.04, +0.48], // 1 FL
    [+0.42, -0.04, +0.14], // 2 MFR
    [-0.42, -0.04, +0.14], // 3 MFL
    [+0.42, -0.04, -0.14], // 4 MBR
    [-0.42, -0.04, -0.14], // 5 MBL
    [+0.42, -0.04, -0.48], // 6 BR
    [-0.42, -0.04, -0.48], // 7 BL
  ];
  /** Natural foot rest positions in body-local space (idle stance). */
  private footRestLocal: [number, number, number][] = [
    [+1.05, -0.55, +0.85], // 0
    [-1.05, -0.55, +0.85], // 1
    [+1.25, -0.55, +0.22], // 2
    [-1.25, -0.55, +0.22], // 3
    [+1.25, -0.55, -0.22], // 4
    [-1.25, -0.55, -0.22], // 5
    [+1.05, -0.55, -0.85], // 6
    [-1.05, -0.55, -0.85], // 7
  ];
  /** Lateral outward knee-bend hint direction in body-local space. */
  private kneeHint: [number, number, number][] = [
    [+1, 0.5, 0],
    [-1, 0.5, 0],
    [+1, 0.5, 0],
    [-1, 0.5, 0],
    [+1, 0.5, 0],
    [-1, 0.5, 0],
    [+1, 0.5, 0],
    [-1, 0.5, 0],
  ];
  // ─── Gait arrays (derived from numLegs; can be overridden in JSON) ────────
  /** Tetrapod group (0 or 1) for each leg. */
  private stepGroup: number[] = [0, 1, 1, 0, 0, 1, 1, 0];
  /** Initial phase tick per leg (0=group fires first, 1=opposite group fires first). */
  private stepInitTick: number[] = [0, 1, 1, 0, 0, 1, 1, 0];
  /** Intra-tetrapod phase offset as a fraction of stepDuration (back→front stagger). */
  private stepPhaseOffset: number[] = [0.75, 0.75, 0.5, 0.5, 0.25, 0.25, 0.0, 0.0];
  /**
   * Predecessor leg index: this leg waits until that leg is past 40 % of its swing.
   * -1 = no constraint (first in back-to-front chain).
   * Default chain: BL(7)→MBR(4)→MFL(3)→FR(0)  and  BR(6)→MBL(5)→MFR(2)→FL(1)
   */
  private stepPredecessor: number[] = [3, 2, 5, 4, 7, 6, -1, -1];

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  public load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;

    // Scalar parameters
    const num = (key: string) => {
      if (typeof d[key] === 'number') (this as any)[key] = d[key] as number;
    };
    num('legUpperLength');
    num('legLowerLength');
    num('legThickness');
    num('stepThreshold');
    num('stepDuration');
    num('stepHeight');
    num('stepAnticipation');
    num('footSpread');
    num('frontLegReach');
    num('backLegReach');
    num('bodyBobAmount');
    num('bodyBobSpeed');
    num('bodyTiltAmount');
    num('moveSpeed');
    num('chaseRange');
    if (typeof d['legMesh'] === 'string') this.legMesh = d['legMesh'] as string;
    if (typeof d['legMaterial'] === 'string') this.legMaterial = d['legMaterial'] as string;

    // Leg count — if changed, regenerate geometry + gait defaults before applying overrides.
    if (typeof d['numLegs'] === 'number' && d['numLegs'] !== this.numLegs) {
      this.numLegs = d['numLegs'] as number;
      this.generateDefaultGeometry(this.numLegs);
      this.rebuildGaitArrays(this.numLegs);
    }

    // Per-leg geometry overrides (each entry is [x, y, z]).
    const parseVec3Array = (key: string, target: [number, number, number][]) => {
      const arr = d[key];
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length && i < target.length; i++) {
        const v = arr[i];
        if (Array.isArray(v) && v.length >= 3) {
          target[i] = [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
        }
      }
    };
    parseVec3Array('hipLocal', this.hipLocal);
    parseVec3Array('footRestLocal', this.footRestLocal);
    parseVec3Array('kneeHint', this.kneeHint);

    // Gait array overrides (number[]).
    const parseNumArray = (key: string, target: number[]) => {
      const arr = d[key];
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length && i < target.length; i++) {
        if (typeof arr[i] === 'number') target[i] = arr[i] as number;
      }
    };
    parseNumArray('stepGroup', this.stepGroup);
    parseNumArray('stepInitTick', this.stepInitTick);
    parseNumArray('stepPhaseOffset', this.stepPhaseOffset);
    parseNumArray('stepPredecessor', this.stepPredecessor);
  }

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

    // Spawn leg child entities now so initLegs() can find them on the first update().
    await this.spawnLegEntities();
  }

  /**
   * Procedurally creates the Leg{i}_Upper and Leg{i}_Lower child entities.
   * Each is a thin box driven by IK — no need to define them in the prefab.
   */
  private async spawnLegEntities(): Promise<void> {
    const owner = this.getOwner();
    const em = Engine.getEntities();

    for (let i = 0; i < this.numLegs; i++) {
      for (const seg of ['Upper', 'Lower'] as const) {
        const segLen = seg === 'Upper' ? this.legUpperLength : this.legLowerLength;

        const child = new Entity();
        owner.addChildren(child);
        em.addEntity(child);
        child.isPoolEntity = true; // hide from scene panel

        const nameComp = new NameComponent();
        nameComp.load(`Leg${i}_${seg}`);
        child.addComponent('name', nameComp);

        const tx = new TransformComponent();
        child.addComponent('transform', tx);
        tx.load({
          position: [0, 0, 0],
          scale: [this.legThickness, this.legThickness, segLen],
        } as TransformComponentDataType);
        em.addComponentToManager(tx, 'transform');

        const rc = new RenderComponent();
        rc.setOwner(child);
        child.addComponent('render', rc);
        await rc.load({ meshes: [{ mesh: this.legMesh, material: this.legMaterial }] });
        em.addComponentToManager(rc, 'render');

        this.legEntities.push(child);
      }
    }
  }

  /**
   * Generates evenly-spaced default hip, foot-rest, and knee-hint arrays for `n` legs.
   * Called automatically when `numLegs` changes via JSON; can also be called manually.
   */
  private generateDefaultGeometry(n: number): void {
    const pairs = Math.max(1, Math.floor(n / 2));
    const zFront = 0.48,
      zBack = -0.48;
    const fzFront = 0.85,
      fzBack = -0.85;
    const zStep = pairs > 1 ? (zFront - zBack) / (pairs - 1) : 0;
    const fzStep = pairs > 1 ? (fzFront - fzBack) / (pairs - 1) : 0;
    this.hipLocal = [];
    this.footRestLocal = [];
    this.kneeHint = [];
    for (let i = 0; i < n; i++) {
      const pairIdx = Math.floor(i / 2);
      const sign = i % 2 === 0 ? 1 : -1;
      const z = zFront - pairIdx * zStep;
      const fz = fzFront - pairIdx * fzStep;
      this.hipLocal.push([sign * 0.42, -0.04, z]);
      this.footRestLocal.push([sign * 1.15, -0.55, fz]);
      this.kneeHint.push([sign, 0.5, 0]);
    }
  }

  /**
   * Derives gait arrays (stepGroup, stepInitTick, stepPhaseOffset, stepPredecessor)
   * from a given leg count using the alternating-tetrapod pattern.
   * Pairs are indexed front-to-back; within each pair index 0 = right, 1 = left.
   */
  private rebuildGaitArrays(n: number): void {
    const pairs = Math.max(1, Math.floor(n / 2));
    this.stepGroup = new Array(n);
    this.stepInitTick = new Array(n);
    this.stepPhaseOffset = new Array(n);
    this.stepPredecessor = new Array(n).fill(-1);

    for (let i = 0; i < n; i++) {
      const pairIdx = Math.floor(i / 2);
      const isRight = i % 2 === 0;
      const group = isRight ? pairIdx % 2 : (pairIdx + 1) % 2;
      this.stepGroup[i] = group;
      this.stepInitTick[i] = group;
      // Phase: backmost pair fires first (0.0), frontmost fires last (0.75).
      const pairFromBack = pairs - 1 - pairIdx;
      this.stepPhaseOffset[i] =
        pairs > 1 ? Math.round((pairFromBack / (pairs - 1)) * 0.75 * 100) / 100 : 0;
    }

    // Predecessor: within each group, front legs wait for the leg immediately behind them.
    const groups: number[][] = [[], []];
    for (let i = 0; i < n; i++) groups[this.stepGroup[i]!]!.push(i);
    for (const g of groups) {
      g.sort((a, b) => a - b); // ascending = front-to-back in index
      // g[last] has the highest index = furthest back = no predecessor.
      // Each leg g[k] waits for g[k+1] (the one behind it).
      for (let k = 0; k < g.length - 1; k++) {
        this.stepPredecessor[g[k]!] = g[k + 1]!;
      }
      this.stepPredecessor[g[g.length - 1]!] = -1;
    }
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

    for (let i = 0; i < this.numLegs; i++) {
      const upper = childByName.get(`Leg${i}_Upper`);
      const lower = childByName.get(`Leg${i}_Lower`);
      if (!upper || !lower) {
        console.warn(`SpiderControllerComponent: missing leg ${i} child transforms`);
        continue;
      }

      // Initial planted foot = rest in body-local → world.
      // Use the TRS world-matrix formula: worldOff = rot * (scale ⊗ local)  (scale FIRST).
      // This must match the body mesh rendering (mat4.fromRotationTranslationScale).
      const rawRest = this.footRestLocal[i]!;
      const zReach = i < Math.floor(this.numLegs / 2) ? this.frontLegReach : this.backLegReach;
      const restLocal = vec3.fromValues(
        rawRest[0] * this.footSpread,
        rawRest[1],
        rawRest[2] * this.footSpread * zReach,
      );
      const restScaled = vec3.multiply(vec3.create(), restLocal, this.bodyScale);
      const planted = vec3.add(
        vec3.create(),
        bodyWorldPos,
        vec3.transformQuat(vec3.create(), restScaled, bodyWorldRot),
      );

      // Group 1 legs get a half-cycle offset so the two tetrapods alternate.
      const initialCooldown =
        this.stepInitTick[i]! * this.stepDuration + this.stepPhaseOffset[i]! * this.stepDuration;

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

    // Body bob: oscillate vertically when moving.
    this.bodyBobPhase += this.bodyBobSpeed * dt;
    const bobOffset = Math.sin(this.bodyBobPhase) * this.bodyBobAmount * (speed > 0.1 ? 1 : 0);

    // Body tilt: roll into the turn direction.
    const tiltRoll =
      -Math.sign(dyaw) * Math.min(Math.abs(dyaw) / Math.PI, 1.0) * this.bodyTiltAmount;
    const DEG = 180 / Math.PI;
    const bodyRot = quat.fromEuler(quat.create(), tiltRoll * DEG, this.currentYaw * DEG, 0);
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
    rb.setLinvel(
      { x: corrected.x / dt, y: corrected.y / dt + bobOffset, z: corrected.z / dt },
      true,
    );

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
      const rawRest = this.footRestLocal[i]!;
      const zReach = i < Math.floor(this.numLegs / 2) ? this.frontLegReach : this.backLegReach;
      const restLocal = vec3.fromValues(
        rawRest[0] * this.footSpread,
        rawRest[1],
        rawRest[2] * this.footSpread * zReach,
      );
      const restScaled = vec3.multiply(vec3.create(), restLocal, bodyScale);
      const restWorld = vec3.add(
        vec3.create(),
        bodyPos,
        vec3.transformQuat(vec3.create(), restScaled, bodyRot),
      );

      const dist = vec3.dist(leg.planted, restWorld);

      // Forced step: the leg has stretched far beyond its natural range (e.g. during
      // a sharp turn). Bypass all gating so it snaps back immediately.
      const isForced = dist > this.stepThreshold * 2.0;

      if (!isForced) {
        // Cheap early-out: foot is still close to its rest position.
        if (dist <= this.stepThreshold * 0.8) continue;

        // Normal gating: cooldown, opposite group, predecessor chain.
        if (leg.cooldown > 0) continue;
        if (this.isOppositeGroupStepping(this.stepGroup[i]!)) continue;

        // Intra-tetrapod ordering: stagger back→front within the group.
        // Only block if the predecessor is currently in the first 40 % of its swing.
        const pred = this.stepPredecessor[i]!;
        if (pred >= 0) {
          const predLeg = this.legs[pred]!;
          if (predLeg.stepping && predLeg.stepT < 0.4) continue;
        }

        if (dist <= this.stepThreshold) continue;
      }

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

  /** Returns true if any leg in the OPPOSITE group is currently mid-step. */
  private isOppositeGroupStepping(group: number): boolean {
    const opposite = group === 0 ? 1 : 0;
    for (let i = 0; i < this.legs.length; i++) {
      if (this.stepGroup[i] === opposite && this.legs[i]!.stepping) return true;
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
      const hipScaled = vec3.multiply(
        vec3.create(),
        vec3.fromValues(...this.hipLocal[i]!),
        bodyScale,
      );
      const hipWorld = vec3.add(
        vec3.create(),
        bodyPos,
        vec3.transformQuat(vec3.create(), hipScaled, bodyRot),
      );

      // Rotate the body-local knee hint into world space.
      const hintLocal = vec3.fromValues(...this.kneeHint[i]!);
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
    // Dispose leg child entities created by spawnLegEntities().
    for (const child of this.legEntities) {
      child.getComponent('render')?.dispose();
    }
    this.legEntities = [];
  }

  public renderDebug(): void {}

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Spider Controller');
    this._editorFolder.close();

    // ── Per-leg geometry (at the top so it's always visible) ────────────────
    {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const ctx = { leg: 0 };

      // Plain mirror objects — lil-gui reads/writes these directly.
      // syncFromLeg() loads the selected leg's data into them.
      const eHip = { x: 0, y: 0, z: 0 };
      const eFoot = { x: 0, y: 0, z: 0 };
      const eKnee = { x: 0, y: 0, z: 0 };

      const syncFromLeg = (i: number): void => {
        const h = self.hipLocal[i];
        if (h) {
          eHip.x = h[0];
          eHip.y = h[1];
          eHip.z = h[2];
        }
        const f = self.footRestLocal[i];
        if (f) {
          eFoot.x = f[0];
          eFoot.y = f[1];
          eFoot.z = f[2];
        }
        const k = self.kneeHint[i];
        if (k) {
          eKnee.x = k[0];
          eKnee.y = k[1];
          eKnee.z = k[2];
        }
      };
      syncFromLeg(0);

      const legsFolder = this._editorFolder.addFolder('Leg Geometry');
      legsFolder.close();

      legsFolder
        .add(ctx, 'leg', 0, Math.max(0, this.numLegs - 1), 1)
        .name('Leg Index')
        .onChange((v: number) => {
          syncFromLeg(v);
          legsFolder.controllersRecursive().forEach((c: any) => c.updateDisplay());
        });

      const hipF = legsFolder.addFolder('Hip Anchor');
      hipF
        .add(eHip, 'x', -2, 2, 0.01)
        .name('X')
        .onChange((v: number) => {
          if (self.hipLocal[ctx.leg]) self.hipLocal[ctx.leg]![0] = v;
        });
      hipF
        .add(eHip, 'y', -1, 1, 0.01)
        .name('Y')
        .onChange((v: number) => {
          if (self.hipLocal[ctx.leg]) self.hipLocal[ctx.leg]![1] = v;
        });
      hipF
        .add(eHip, 'z', -2, 2, 0.01)
        .name('Z')
        .onChange((v: number) => {
          if (self.hipLocal[ctx.leg]) self.hipLocal[ctx.leg]![2] = v;
        });

      const footF = legsFolder.addFolder('Foot Rest');
      footF
        .add(eFoot, 'x', -3, 3, 0.01)
        .name('X')
        .onChange((v: number) => {
          if (self.footRestLocal[ctx.leg]) self.footRestLocal[ctx.leg]![0] = v;
        });
      footF
        .add(eFoot, 'y', -2, 0, 0.01)
        .name('Y')
        .onChange((v: number) => {
          if (self.footRestLocal[ctx.leg]) self.footRestLocal[ctx.leg]![1] = v;
        });
      footF
        .add(eFoot, 'z', -2, 2, 0.01)
        .name('Z')
        .onChange((v: number) => {
          if (self.footRestLocal[ctx.leg]) self.footRestLocal[ctx.leg]![2] = v;
        });

      const kneeF = legsFolder.addFolder('Knee Hint');
      kneeF
        .add(eKnee, 'x', -2, 2, 0.01)
        .name('X')
        .onChange((v: number) => {
          if (self.kneeHint[ctx.leg]) self.kneeHint[ctx.leg]![0] = v;
        });
      kneeF
        .add(eKnee, 'y', -1, 2, 0.01)
        .name('Y')
        .onChange((v: number) => {
          if (self.kneeHint[ctx.leg]) self.kneeHint[ctx.leg]![1] = v;
        });
      kneeF
        .add(eKnee, 'z', -2, 2, 0.01)
        .name('Z')
        .onChange((v: number) => {
          if (self.kneeHint[ctx.leg]) self.kneeHint[ctx.leg]![2] = v;
        });
    }

    this._editorFolder.add(this, 'footSpread', 0.5, 3.0).step(0.05).name('Foot Spread').listen();
    this._editorFolder
      .add(this, 'frontLegReach', 0.5, 2.0)
      .step(0.05)
      .name('Front Leg Reach')
      .listen();
    this._editorFolder
      .add(this, 'backLegReach', 0.5, 2.0)
      .step(0.05)
      .name('Back Leg Reach')
      .listen();
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
    this._editorFolder
      .add(this, 'bodyBobAmount', 0.0, 0.2)
      .step(0.005)
      .name('Body Bob Amount')
      .listen();
    this._editorFolder
      .add(this, 'bodyBobSpeed', 1.0, 20.0)
      .step(0.5)
      .name('Body Bob Speed')
      .listen();
    this._editorFolder
      .add(this, 'bodyTiltAmount', 0.0, 0.3)
      .step(0.01)
      .name('Body Tilt Amount')
      .listen();

    this._editorFolder
      .add({ numLegs: this.numLegs }, 'numLegs')
      .name('Num Legs (JSON only)')
      .disable();
  }
}
