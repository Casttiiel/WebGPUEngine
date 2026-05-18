import { vec3, quat } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { TransformComponent } from '../core/TransformComponent';
import { Blackboard } from '../../ai/Blackboard';
import { BehaviorTree } from '../../ai/BehaviorTree';
import { Action, Condition, Selector, Sequence, Status } from '../../ai';
import { BehaviorNode } from '../../ai/BehaviorNode';
import { RequestPathAction } from '../../ai/nodes/RequestPathAction';
import { SteerAction } from '../../ai/nodes/SteerAction';
import { ShootAction } from '../../ai/nodes/ShootAction';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { BloodDrainSourceComponent } from './BloodDrainSourceComponent';
import { ChargeTargetComponent } from './ChargeTargetComponent';
import { Material } from '../../renderer/resources/Material';
import { RenderComponent } from '../render/RenderComponent';

/**
 * EnemyControllerComponent
 *
 * Kinematic physics controller driven by a Behavior Tree instead of player input.
 *
 * Architecture:
 *  - Mirrors CharacterControllerComponent but replaces keyboard input with
 *    `desiredHorizontal: vec3` written by BT Action nodes each tick.
 *  - Owns a Blackboard and a BehaviorTree. Subclass and override `buildTree()`
 *    to define different enemy behaviours.
 *  - Stores a reference to `this` in the Blackboard under the key `'self'`
 *    so Action nodes can call `setDesiredHorizontal()` without closure captures.
 *
 * Required components on the same entity:
 *  - CapsuleColliderComponent (bodyType: DYNAMIC, lockRotationX: true, lockRotationZ: true)
 *
 * Blackboard keys written by this component:
 *  - 'self'          → EnemyControllerComponent (for Action nodes)
 *  - 'position'      → vec3 (world position, updated each tick)
 *  - 'isGrounded'    → boolean
 *  - 'spawnPosition' → vec3 (world position at spawn time, set once in onAttach)
 *  - 'hasLastKnown'  → boolean (set by PerceptionComponent, cleared after investigation)
 *
 * Blackboard keys read by the default tree (written externally by PerceptionComponent):
 *  - 'canSeePlayer'  → boolean
 *  - 'playerPosition'→ vec3 (last known player position — persists after losing sight)
 *
 * @example – JSON component entry:
 * {
 *   "enemy_controller": {
 *     "moveSpeed": 4.0,
 *     "gravity": 20,
 *     "acceleration": 10
 *   }
 * }
 */
export class EnemyControllerComponent extends Component {
  // ─── Physics ───────────────────────────────────────────────────────────────
  protected capsuleCollider!: CapsuleColliderComponent;
  protected characterController!: RAPIER.KinematicCharacterController;

  // ─── Movement state ────────────────────────────────────────────────────────
  /** Horizontal velocity (XZ plane) set by BT Action nodes. */
  protected desiredHorizontal: vec3 = vec3.create();
  /** Current smoothed horizontal velocity after acceleration. */
  protected currentHorizontal: vec3 = vec3.create();
  /** Vertical velocity — managed internally (gravity + grounded clamping). */
  private verticalVelocity: number = 0;
  protected isGrounded: boolean = false;

  // ─── Parameters ────────────────────────────────────────────────────────────
  protected moveSpeed: number = 3.5;
  private gravity: number = 20;
  private acceleration: number = 10;
  /** Maximum yaw rotation speed in radians/second. */
  private turnSpeed: number = 240 * (Math.PI / 180); // 240 deg/s default

  // ─── Rotation state ────────────────────────────────────────────────────────
  /** Current yaw angle (radians). Maintained internally and applied to the rigid body. */
  private currentYaw: number = 0;
  /** Desired yaw angle written by faceToward(). Applied smoothly in update(). */
  private desiredYaw: number = 0;

  // ─── AI ────────────────────────────────────────────────────────────────────
  public readonly bb: Blackboard = new Blackboard();
  protected tree!: BehaviorTree;
  /** World position recorded once at spawn. Used as the return-home target. */
  private spawnPosition: vec3 = vec3.create();
  /** Human-readable label of the currently-running BT branch. Updated in update(). */
  public currentState: string = 'IDLE';
  /** DOM element used to render the state label on screen. */
  private stateEl: HTMLElement | null = null;
  /** True once ON_DEATH received — stops the AI update loop. */
  private dead: boolean = false;
  /** BloodDrainSourceComponent on the same entity, activated on death. */
  private bloodDrainSource: BloodDrainSourceComponent | null = null;
  /** Cloned material for per-enemy debug tinting (yellow=chargeable, red=dead). */
  private clonedMaterial: Material | null = null;
  /** ChargeTargetComponent on the first child, used to detect chargeable state. */
  private chargeTarget: ChargeTargetComponent | null = null;
  /** Cached player entity id for chargeable check (-1 = not yet found). */
  private playerEntityId: number = -1;
  /** Remaining seconds of slow effect. Counts down each frame. */
  private slowTimer: number = 0;
  /** Speed multiplier applied while slowTimer > 0 (set by BloodZoneComponent). */
  private slowFactor: number = 1.0;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public async load(data: EnemyControllerComponentDataType): Promise<void> {
    this.moveSpeed = data.moveSpeed ?? this.moveSpeed;
    this.gravity = data.gravity ?? this.gravity;
    this.acceleration = data.acceleration ?? this.acceleration;
    if (data.turnSpeed !== undefined) this.turnSpeed = data.turnSpeed * (Math.PI / 180);

    // Physics
    this.capsuleCollider = this.getOwner().getComponent(
      'capsule_collider',
    ) as CapsuleColliderComponent;
    if (!this.capsuleCollider) {
      console.error(
        'EnemyControllerComponent: requires CapsuleColliderComponent on the same entity!',
      );
      return;
    }

    this.characterController = Engine.getPhysics().createCharacterControllerPhysicsForCollider();

    // Seed the blackboard with self-reference and initial values
    this.bb.set<EnemyControllerComponent>('self', this);
    this.bb.set<vec3>('position', vec3.create());
    this.bb.set<vec3>('facing', vec3.fromValues(0, 0, 1)); // overwritten in onAttach
    this.bb.set<boolean>('isGrounded', false);
    this.bb.set<boolean>('canSeePlayer', false);
    this.bb.set<vec3>('playerPosition', vec3.create());
    this.bb.set<boolean>('hasLastKnown', false);
    // spawnPosition is set in onAttach once the rigid body is positioned

    // Build the behavior tree
    this.tree = new BehaviorTree(this.buildTree(), this.bb);
  }

  /**
   * Called after ALL components on the entity are loaded.
   * At this point TransformComponent already has the rotation from the prefab.
   */
  public override async onAttach(): Promise<void> {
    this.syncFacingFromTransform();

    // Record spawn position from the rigid body (physics is initialised by now)
    const t = this.capsuleCollider.getRigidBody().translation();
    vec3.set(this.spawnPosition, t.x, t.y, t.z);
    this.bb.set<vec3>('spawnPosition', vec3.clone(this.spawnPosition));

    // Create on-screen state label
    const id = `enemy-state-${this.getOwner().getName()}`;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText =
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,0.55);color:#fff;font:bold 13px/1 monospace;' +
        'padding:5px 14px;border-radius:4px;pointer-events:none;z-index:9999;letter-spacing:1px;';
      document.body.appendChild(el);
    }
    this.stateEl = el;
    this.bloodDrainSource = this.getOwner().getComponent(
      'blood_drain_source',
    ) as BloodDrainSourceComponent | null;

    // Find the ChargeTarget child
    for (const child of this.getOwner().getChildren()) {
      const ct = child.getComponent('charge_target') as ChargeTargetComponent | null;
      if (ct) {
        this.chargeTarget = ct;
        break;
      }
    }

    // Clone the material so per-enemy tinting doesn't affect shared GPU data.
    const renderComp = this.getOwner().getComponent('render') as RenderComponent | null;
    const firstPart = renderComp?.getParts()[0];
    if (firstPart) {
      const clone = Material.cloneFrom(firstPart.material);
      if (clone) {
        this.clonedMaterial = clone;
        renderComp!.setPartMaterial(0, clone);
      }
    }
  }

  // ─── Main update ───────────────────────────────────────────────────────────

  public update(deltaTime: number): void {
    if (this.dead) {
      // Post-death: destroy entity once blood is fully drained.
      if (this.bloodDrainSource?.isDepleted()) {
        Engine.getEntities().destroyEntity(this.getOwner());
      }
      return;
    }
    if (!this.capsuleCollider || !this.characterController) return;

    // 1. Sync world position + facing into blackboard
    const pos = this.capsuleCollider.getRigidBody().translation();
    const bbPos = this.bb.get<vec3>('position') ?? vec3.create();
    vec3.set(bbPos, pos.x, pos.y, pos.z);
    this.bb.set('position', bbPos);

    // 1b. Smooth rotation — advance currentYaw toward desiredYaw at turnSpeed.
    this.applyTurnStep(deltaTime);

    // 2. Ground detection
    this.updateGroundedState();
    this.bb.set('isGrounded', this.isGrounded);

    // 3. Gravity
    if (this.isGrounded && this.verticalVelocity < 0) {
      this.verticalVelocity = -0.5; // small constant keeps snap-to-ground happy
    } else {
      this.verticalVelocity -= this.gravity * deltaTime;
    }

    // 4. Step the behavior tree — Action nodes may call setDesiredHorizontal()
    this.tree.step();

    // 4c. Apply slow effect (re-affirmed each frame by BloodZoneComponent)
    if (this.slowTimer > 0) {
      this.slowTimer -= deltaTime;
      vec3.scale(this.desiredHorizontal, this.desiredHorizontal, this.slowFactor);
    }

    // 4b. Derive current AI state from blackboard for the on-screen display
    const canSee = this.bb.get<boolean>('canSeePlayer', false);
    const hasLast = this.bb.get<boolean>('hasLastKnown', false);
    const bbSpawn = this.bb.get<vec3>('spawnPosition');
    const bbPosNow = this.bb.get<vec3>('position');
    const atHome = !bbPosNow || !bbSpawn || vec3.distance(bbPosNow, bbSpawn) <= 1.5;
    let newState: string;
    if (canSee) {
      newState = 'SHOOT';
    } else if (hasLast) {
      newState = 'INVESTIGATE';
    } else if (!atHome) {
      newState = 'RETURN HOME';
    } else {
      newState = 'IDLE';
    }
    if (newState !== this.currentState) {
      const pos = this.capsuleCollider.getRigidBody().translation();
      const target = this.bb.get<vec3>('playerPosition');
      console.log(
        `[AI] ${this.currentState} → ${newState}` +
          `  enemyPos=(${pos.x.toFixed(1)},${pos.z.toFixed(1)})` +
          (target ? `  lastKnown=(${target[0].toFixed(1)},${target[2].toFixed(1)})` : ''),
      );
    }
    this.currentState = newState;
    if (this.stateEl) this.stateEl.textContent = `AI: ${this.currentState}`;

    // 5. Smooth horizontal velocity toward desired (exponential acceleration)
    const t = 1 - Math.exp(-this.acceleration * deltaTime);
    vec3.lerp(this.currentHorizontal, this.currentHorizontal, this.desiredHorizontal, t);

    // 6. Apply movement through the KCC
    this.applyMovement(deltaTime);

    // 7. Reset desired horizontal for next tick (BT must re-affirm each frame)
    vec3.set(this.desiredHorizontal, 0, 0, 0);

    // Debug tinting: yellow when chargeable by player, white otherwise.
    if (this.clonedMaterial) {
      const chargeable = this.isChargeableByPlayer();
      this.clonedMaterial.setFactors({
        baseColorFactor: chargeable ? [1, 0.9, 0.1, 1] : [1, 1, 1, 1],
      });
    }
  }

  // ─── API for BT Action nodes ───────────────────────────────────────────────

  /**
   * Set the desired horizontal movement direction + speed for this tick.
   * `direction` is expected to be a normalised XZ vector.
   * Velocity magnitude = moveSpeed unless `speed` is given explicitly.
   */
  public setDesiredHorizontal(direction: vec3, speed?: number): void {
    const s = speed ?? this.moveSpeed;
    vec3.set(this.desiredHorizontal, direction[0] * s, 0, direction[2] * s);
  }

  /**
   * Called by BloodZoneComponent each frame the enemy is inside the zone.
   * Stacks duration additively so re-entering the zone refreshes the slow.
   */
  public applySlowEffect(factor: number, duration: number): void {
    this.slowFactor = factor;
    this.slowTimer = Math.max(this.slowTimer, duration);
  }

  /**
   * Requests a smooth rotation toward `target` (yaw only).
   * The actual rotation is applied gradually in update() at `turnSpeed` rad/s.
   * BT nodes call this every tick — it's safe to call with a new target each frame.
   */
  public faceToward(target: vec3): void {
    const pos = this.bb.get<vec3>('position')!;
    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.desiredYaw = Math.atan2(dx, dz);
  }

  /**
   * Advances currentYaw toward desiredYaw by at most `turnSpeed * dt` radians,
   * then writes the result to the rigid body and updates bb['facing'].
   */
  private applyTurnStep(dt: number): void {
    // Compute the shortest angular delta in [-π, π]
    let delta = this.desiredYaw - this.currentYaw;
    // Wrap to [-π, π]
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;

    const maxStep = this.turnSpeed * dt;
    const step = Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
    this.currentYaw += step;

    // Write to the rigid body
    const halfYaw = this.currentYaw / 2;
    this.capsuleCollider
      .getRigidBody()
      .setRotation({ x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) }, true);

    // Keep bb['facing'] in sync (used by PerceptionComponent for FOV)
    const facing = this.bb.get<vec3>('facing') ?? vec3.create();
    vec3.set(facing, Math.sin(this.currentYaw), 0, Math.cos(this.currentYaw));
    this.bb.set('facing', facing);
  }

  // ─── Facing helpers ───────────────────────────────────────────────────────

  /**
   * Reads yaw from the TransformComponent (set by the prefab rotation)
   * and writes the corresponding forward XZ vector into `bb['facing']`.
   * Call once in onAttach() so the initial prefab rotation is respected.
   */
  private syncFacingFromTransform(): void {
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (!transform) return;
    const { yaw } = transform.getTransform().getAngles();
    this.currentYaw = yaw;
    this.desiredYaw = yaw;
    const facing = this.bb.get<vec3>('facing') ?? vec3.create();
    vec3.set(facing, Math.sin(yaw), 0, Math.cos(yaw));
    this.bb.set('facing', facing);
  }

  public getMoveSpeed(): number {
    return this.moveSpeed;
  }
  public getIsGrounded(): boolean {
    return this.isGrounded;
  }
  public getVerticalVelocity(): number {
    return this.verticalVelocity;
  }
  /** Returns the current smoothed horizontal velocity (XZ). Used by SteerAction for RVO. */
  public getCurrentHorizontal(): vec3 {
    return this.currentHorizontal;
  }

  // ─── Override in subclasses ────────────────────────────────────────────────

  /**
   * State machine encoded as a prioritised reactive Selector:
   *
   *   SHOOT       — sees player → stop, face, fire at configurable rate
   *   INVESTIGATE (NavMesh)  — lost sight, hasLastKnown → A* to last known → Steer → clear
   *   INVESTIGATE (direct)   — lost sight, hasLastKnown → direct move to last known → clear
   *   RETURN      (NavMesh)  — not at home  → A* path to spawn → Steer
   *   RETURN      (direct)   — not at home  → direct move to spawn
   *   IDLE
   *
   * NavMesh branches fail gracefully (RequestPathAction returns FAILURE) so the
   * direct-movement fallback always covers scenes without a navmesh.
   */
  protected buildTree(): BehaviorNode {
    // ── Shared condition factories (new instance per call — BT nodes are stateful) ──
    const canSee = () =>
      new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false));
    const hasLastKnown = () =>
      new Condition('HasLastKnown', (bb) => bb.get<boolean>('hasLastKnown', false));
    const notAtHome = () =>
      new Condition('NotAtHome', (bb) => {
        const pos = bb.get<vec3>('position');
        const spawn = bb.get<vec3>('spawnPosition');
        return !!pos && !!spawn && vec3.distance(pos, spawn) > 1.5;
      });

    // ── Clears investigation state once Steer arrives at last known position ──
    const clearInvestigation = new Action('ClearInvestigation', (bb) => {
      bb.set<boolean>('hasLastKnown', false);
      bb.delete('currentPath');
      console.log('[AI] Investigation complete — returning to spawn');
      return Status.SUCCESS;
    });

    /** Direct movement toward a BB position key. Returns SUCCESS within 1.5 m. */
    const moveDirectlyTo = (
      label: string,
      targetKey: string,
      onArrival?: (bb: Blackboard) => void,
    ) =>
      new Action(label, (bb) => {
        const self = bb.get<EnemyControllerComponent>('self')!;
        const pos = bb.get<vec3>('position')!;
        const target = bb.get<vec3>(targetKey)!;

        const dir = vec3.subtract(vec3.create(), target, pos);
        dir[1] = 0;
        const dist = vec3.length(dir);

        if (dist < 1.5) {
          onArrival?.(bb);
          return Status.SUCCESS;
        }

        vec3.normalize(dir, dir);
        self.setDesiredHorizontal(dir);
        self.faceToward(target);
        return Status.RUNNING;
      });

    return new Selector(
      [
        // ── 1. SHOOT (player visible) ──────────────────────────────────────
        new Sequence([canSee(), new ShootAction()], {
          reactive: true,
        }),

        // ── 3. INVESTIGATE (NavMesh) ─────────────────────────────────────────
        // Goes to last known player position. clearInvestigation fires once
        // SteerAction returns SUCCESS, setting hasLastKnown=false so RETURN fires next.
        new Sequence(
          [
            hasLastKnown(),
            new RequestPathAction('playerPosition'),
            new SteerAction(),
            clearInvestigation,
          ],
          { reactive: true },
        ),

        // ── 4. INVESTIGATE (direct fallback) ────────────────────────────────
        new Sequence(
          [
            hasLastKnown(),
            moveDirectlyTo('InvestigateDirectly', 'playerPosition', (bb) => {
              bb.set<boolean>('hasLastKnown', false);
              bb.delete('currentPath');
              console.log('[AI] Investigation complete (direct) — returning to spawn');
            }),
          ],
          { reactive: true },
        ),

        // ── 5. RETURN HOME (NavMesh) ─────────────────────────────────────────
        new Sequence([notAtHome(), new RequestPathAction('spawnPosition'), new SteerAction()], {
          reactive: true,
        }),

        // ── 6. RETURN HOME (direct fallback) ────────────────────────────────
        new Sequence([notAtHome(), moveDirectlyTo('ReturnDirectly', 'spawnPosition')], {
          reactive: true,
        }),

        // ── 7. IDLE ──────────────────────────────────────────────────────────
        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'EnemyRoot', reactive: true },
    );
  }

  // ─── Physics internals ─────────────────────────────────────────────────────

  private updateGroundedState(): void {
    const hit = this.capsuleCollider.raycastGrounded(0.2);
    this.isGrounded = hit !== null;
  }

  private applyMovement(dt: number): void {
    const vx = this.currentHorizontal[0];
    const vz = this.currentHorizontal[2];
    const vy = this.verticalVelocity;

    const movement = new RAPIER.Vector3(vx * dt, vy * dt, vz * dt);

    this.characterController.computeColliderMovement(
      this.capsuleCollider.getCollider(),
      movement,
      QueryFilterFlags.EXCLUDE_SENSORS,
    );

    const corrected = this.characterController.computedMovement();

    this.capsuleCollider
      .getRigidBody()
      .setLinvel({ x: corrected.x / dt, y: corrected.y / dt, z: corrected.z / dt }, true);

    // Cancel vertical velocity if hitting ceiling (corrected.y is much less than requested)
    if (vy > 0 && corrected.y < vy * dt * 0.5) {
      this.verticalVelocity = 0;
    }
  }

  // ─── Death handling ────────────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'enemy_controller', (comp) => {
      (comp as EnemyControllerComponent).onDeath();
    });
  }

  private onDeath(): void {
    this.dead = true;
    // Zero out the rigid body velocity so physics doesn't keep sliding the corpse.
    this.capsuleCollider?.getRigidBody().setLinvel({ x: 0, y: 0, z: 0 }, true);
    if (this.stateEl) this.stateEl.textContent = 'AI: DEAD';
    this.bloodDrainSource?.activate();

    // Red tint
    this.clonedMaterial?.setFactors({ baseColorFactor: [0.9, 0.1, 0.1, 1] });

    // Flip the mesh 180° around Z (compose current yaw with a half-turn).
    const rb = this.capsuleCollider?.getRigidBody();
    if (rb) {
      const rot = rb.rotation();
      const qCurr = quat.fromValues(rot.x, rot.y, rot.z, rot.w);
      const q180Z = quat.fromValues(0, 0, 1, 0); // 180° around Z axis
      const result = quat.multiply(quat.create(), qCurr, q180Z);
      rb.setRotation({ x: result[0], y: result[1], z: result[2], w: result[3] }, true);
    }
  }

  // ─── Debug helpers ─────────────────────────────────────────────────────────

  private isChargeableByPlayer(): boolean {
    if (!this.chargeTarget) return false;
    const pid = this.resolvePlayerId();
    if (pid < 0) return false;
    return ChargeTargetComponent.getInRangeComponents(pid).has(this.chargeTarget);
  }

  private resolvePlayerId(): number {
    if (this.playerEntityId >= 0) return this.playerEntityId;
    for (const entity of Engine.getEntities().getAllEntities()) {
      if (entity.hasComponent('player_controller')) {
        this.playerEntityId = entity.id;
        return this.playerEntityId;
      }
    }
    return -1;
  }

  // ─── Component boilerplate ─────────────────────────────────────────────────

  public override dispose(): void {
    this.stateEl?.remove();
    this.stateEl = null;
    this.clonedMaterial?.release();
    this.clonedMaterial = null;
    if (this.characterController) {
      Engine.getPhysics().getWorld().removeCharacterController(this.characterController);
    }
  }

  public renderDebug(): void {}
  public override renderInMenu(): void {}
}
