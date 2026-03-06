import { vec3 } from 'gl-matrix';
import RAPIER, { QueryFilterFlags } from '@dimforge/rapier3d';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { TransformComponent } from '../core/TransformComponent';
import { Blackboard } from '../../ai/Blackboard';
import { BehaviorTree } from '../../ai/BehaviorTree';
import { Action, Condition, Selector, Sequence, Status } from '../../ai';
import { BehaviorNode } from '../../ai/BehaviorNode';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

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
 *
 * Blackboard keys read by the default tree (written externally by PerceptionComponent):
 *  - 'canSeePlayer'  → boolean
 *  - 'playerPosition'→ vec3
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
  private currentHorizontal: vec3 = vec3.create();
  /** Vertical velocity — managed internally (gravity + grounded clamping). */
  private verticalVelocity: number = 0;
  protected isGrounded: boolean = false;

  // ─── Parameters ────────────────────────────────────────────────────────────
  protected moveSpeed: number = 3.5;
  private gravity: number = 20;
  private acceleration: number = 10;

  // ─── AI ────────────────────────────────────────────────────────────────────
  public readonly bb: Blackboard = new Blackboard();
  protected tree!: BehaviorTree;

  // ─── Init ──────────────────────────────────────────────────────────────────

  public async load(data: EnemyControllerComponentDataType): Promise<void> {
    this.moveSpeed = data.moveSpeed ?? this.moveSpeed;
    this.gravity = data.gravity ?? this.gravity;
    this.acceleration = data.acceleration ?? this.acceleration;

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
    this.bb.set<vec3>('facing', vec3.fromValues(0, 0, 1));
    this.bb.set<boolean>('isGrounded', false);
    this.bb.set<boolean>('canSeePlayer', false);
    this.bb.set<vec3>('playerPosition', vec3.create());

    // Build the behavior tree
    this.tree = new BehaviorTree(this.buildTree(), this.bb);
  }

  // ─── Main update ───────────────────────────────────────────────────────────

  public update(deltaTime: number): void {
    if (!this.capsuleCollider || !this.characterController) return;

    // 1. Sync world position into blackboard
    const pos = this.capsuleCollider.getRigidBody().translation();
    const bbPos = this.bb.get<vec3>('position') ?? vec3.create();
    vec3.set(bbPos, pos.x, pos.y, pos.z);
    this.bb.set('position', bbPos);

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

    // 5. Smooth horizontal velocity toward desired (exponential acceleration)
    const t = 1 - Math.exp(-this.acceleration * deltaTime);
    vec3.lerp(this.currentHorizontal, this.currentHorizontal, this.desiredHorizontal, t);

    // 6. Apply movement through the KCC
    this.applyMovement(deltaTime);

    // 7. Reset desired horizontal for next tick (BT must re-affirm each frame)
    vec3.set(this.desiredHorizontal, 0, 0, 0);
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

  /** Immediately face toward `target` (yaw-only rotation via TransformComponent). */
  public faceToward(target: vec3): void {
    const pos = this.bb.get<vec3>('position')!;
    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    const yaw = Math.atan2(dx, dz);
    const transform = this.getOwner().getComponent('transform') as TransformComponent;
    if (transform) transform.getTransform().setAngles(yaw, 0, 0);

    // Keep 'facing' in sync so PerceptionComponent can use it for FOV cone checks
    const len = Math.sqrt(dx * dx + dz * dz);
    const facing = this.bb.get<vec3>('facing') ?? vec3.create();
    vec3.set(facing, dx / len, 0, dz / len);
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

  // ─── Override in subclasses ────────────────────────────────────────────────

  /**
   * Returns the root node of the behavior tree.
   * Override this in a subclass to define a different enemy type.
   *
   * Default tree:
   *   Selector (reactive)
   *     ├─ Sequence — if can see player → move toward them
   *     └─ Action   — idle (RUNNING forever, keeps the selector alive)
   */
  protected buildTree(): BehaviorNode {
    return new Selector(
      [
        // ── Priority 1: Chase player when visible ──────────────────────────
        new Sequence([
          new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false)),
          new Action('ChasePlayer', (bb) => {
            const self = bb.get<EnemyControllerComponent>('self')!;
            const myPos = bb.get<vec3>('position')!;
            const target = bb.get<vec3>('playerPosition')!;

            const toTarget = vec3.subtract(vec3.create(), target, myPos);
            toTarget[1] = 0; // ignore Y — horizontal only
            const dist = vec3.length(toTarget);

            // Stop and succeed when within melee range
            if (dist < 1.5) return Status.SUCCESS;

            // Move toward player
            vec3.normalize(toTarget, toTarget);
            self.setDesiredHorizontal(toTarget);
            self.faceToward(target);
            return Status.RUNNING;
          }),
        ]),

        // ── Priority 2: Idle ───────────────────────────────────────────────
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

  // ─── Component boilerplate ─────────────────────────────────────────────────

  public renderDebug(): void {}
  public override renderInMenu(): void {}

  public dispose(): void {
    if (this.characterController) {
      Engine.getPhysics().getWorld().removeCharacterController(this.characterController);
    }
  }
}
