import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, Status } from '../../ai/BehaviorNode';
import { Action, Condition, Selector, Sequence } from '../../ai';
import { Blackboard } from '../../ai/Blackboard';
import { MeleeAttackComponent } from './combat/MeleeAttackComponent';
import { BulletPoolComponent } from './BulletPoolComponent';
import { CapsuleColliderComponent } from '../physics/CapsuleColliderComponent';
import { TransformComponent } from '../core/TransformComponent';
import { RequestPathAction } from '../../ai/nodes/RequestPathAction';
import { SteerAction } from '../../ai/nodes/SteerAction';
import { Engine } from '../../core/engine/Engine';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

// ── Internal BB keys (prefixed _hm to avoid clashes with other actions) ──────
const K_PHASE = '_hmPhase'; // HeavyPhase
const K_SHOTS = '_hmShots'; // number — shots fired in current burst
const K_NEXT_FIRE = '_hmNextFire'; // number — wall-clock time of next allowed shot
const K_PAUSE_END = '_hmPauseEnd'; // number — wall-clock time vulnerability ends
const K_BACKSTEP_END = '_hmBackstepEnd'; // number — wall-clock time backstep ends

// ── Combat constants ──────────────────────────────────────────────────────────
const MUZZLE_HEIGHT = 0.3; // metres above rigid-body centre
const BURST_SIZE = 3; // shots per burst
const BURST_FIRE_RATE = 4; // shots / second inside a burst
const BURST_PAUSE = 2.0; // seconds of vulnerability between bursts
const BACKSTEP_SPEED = 5.0; // m/s while backstepping away from player
const BACKSTEP_DURATION = 0.5; // seconds of backstep after melee swing
const MELEE_RANGE = 3.0; // metres — triggers AoE melee interrupt
const ADVANCE_RANGE = 20; // metres — starts advancing when player is further

type HeavyPhase = 'IDLE' | 'BURST' | 'VULNERABLE';

/**
 * HeavyMixedController — Enemigo E: Mixto Pesado
 *
 * A boss-tier enemy combining burst ranged fire with close-range AoE melee.
 * High HP but no damage resistance — designed to be a sustained fight.
 *
 * Combat cycle (tracked entirely in Blackboard):
 *   IDLE (initial / after advance) → BURST (3 shots at fireRate 4/s)
 *                                  → VULNERABLE (2 s, no movement, full damage)
 *                                  → IDLE → repeat
 *
 * Melee interrupt (highest BT priority):
 *   When the player steps within MELEE_RANGE, the heavy immediately swings
 *   an AoE (MeleeAttackComponent) and backpedals for BACKSTEP_DURATION seconds.
 *
 * Advance:
 *   If the player is further than ADVANCE_RANGE while IDLE, the heavy
 *   moves toward the player until in range, then starts the burst.
 *
 * Component key: 'heavy_mixed_controller'
 */
export class HeavyMixedController extends EnemyControllerComponent {
  // ── Default stats ─────────────────────────────────────────────────────────

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 4.0,
      gravity: 9,
      acceleration: 8,
      turnSpeed: 180,
      ...data,
    });
  }

  // ── Behavior Tree ─────────────────────────────────────────────────────────

  protected override buildTree(): BehaviorNode {
    // ── Condition factories ────────────────────────────────────────────────
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
    const playerInMeleeRange = () =>
      new Condition('PlayerInMeleeRange', (bb) => {
        const pos = bb.get<vec3>('position')!;
        const target = bb.get<vec3>('playerPosition');
        if (!target) return false;
        const dx = target[0] - pos[0];
        const dz = target[2] - pos[2];
        return Math.sqrt(dx * dx + dz * dz) <= MELEE_RANGE;
      });

    // ── 1. Melee interrupt: AoE swing + backstep ──────────────────────────
    // Highest-priority — fires whenever the player invades personal space.
    const meleeAndBackstep = new Action('MeleeAndBackstep', (bb) => {
      const self = bb.get<EnemyControllerComponent>('self')!;
      const pos = bb.get<vec3>('position')!;
      const target = bb.get<vec3>('playerPosition');
      const now = performance.now() / 1000;

      // Continue backstepping if the backstep timer is still running
      const backstepEnd = bb.get<number>(K_BACKSTEP_END, 0);
      if (now < backstepEnd) {
        if (target) {
          const away = vec3.subtract(vec3.create(), pos, target);
          away[1] = 0;
          if (vec3.length(away) > 0.001) {
            vec3.normalize(away, away);
            self.setDesiredHorizontal(away, BACKSTEP_SPEED);
          }
        }
        return Status.RUNNING;
      }

      // Attempt AoE swing
      if (target) self.faceToward(target);
      const melee = self.getOwner().getComponent('melee_attack') as MeleeAttackComponent | null;
      if (melee && target && melee.canAttack(target, pos)) {
        const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
        const center = (tc?.getTransform().getWorldPosition() ?? pos) as vec3;
        melee.attack(center);
        bb.set(K_BACKSTEP_END, now + BACKSTEP_DURATION);
      }

      return Status.RUNNING;
    });

    // ── 2. Ranged combat cycle: IDLE → BURST → VULNERABLE → IDLE ─────────
    const heavyCombat = new Action('HeavyCombatCycle', (bb) => {
      const self = bb.get<EnemyControllerComponent>('self')!;
      const pos = bb.get<vec3>('position')!;
      const target = bb.get<vec3>('playerPosition');
      if (!target) return Status.RUNNING;

      const now = performance.now() / 1000;
      const phase = bb.get<HeavyPhase>(K_PHASE, 'IDLE');

      self.faceToward(target);

      // ── VULNERABLE — stand still; player's window to deal full damage ────
      if (phase === 'VULNERABLE') {
        if (now >= bb.get<number>(K_PAUSE_END, 0)) {
          bb.set<HeavyPhase>(K_PHASE, 'IDLE');
        }
        // Intentionally no movement
        return Status.RUNNING;
      }

      // ── BURST — fire shots at BURST_FIRE_RATE until BURST_SIZE reached ──
      if (phase === 'BURST') {
        if (now >= bb.get<number>(K_NEXT_FIRE, 0)) {
          this.fireProjectile(self, pos, target);

          const shots = bb.get<number>(K_SHOTS, 0) + 1;
          if (shots >= BURST_SIZE) {
            bb.set<HeavyPhase>(K_PHASE, 'VULNERABLE');
            bb.set(K_PAUSE_END, now + BURST_PAUSE);
            bb.set(K_SHOTS, 0);
          } else {
            bb.set(K_SHOTS, shots);
            bb.set(K_NEXT_FIRE, now + 1.0 / BURST_FIRE_RATE);
          }
        }
        return Status.RUNNING;
      }

      // ── IDLE — advance if player is too far, else start burst ───────────
      const dx = target[0] - pos[0];
      const dz = target[2] - pos[2];
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > ADVANCE_RANGE) {
        const dir = vec3.fromValues(dx / dist, 0, dz / dist);
        self.setDesiredHorizontal(dir);
      } else {
        bb.set<HeavyPhase>(K_PHASE, 'BURST');
        bb.set(K_SHOTS, 0);
        bb.set(K_NEXT_FIRE, now);
      }

      return Status.RUNNING;
    });

    // ── Shared direct-movement helper ─────────────────────────────────────
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
        // 1. MELEE INTERRUPT — punish player for closing in
        new Sequence([playerInMeleeRange(), meleeAndBackstep], { reactive: true }),

        // 2. RANGED COMBAT CYCLE — burst fire → vulnerability → repeat
        new Sequence([canSee(), heavyCombat], { reactive: true }),

        // 3. INVESTIGATE (NavMesh)
        new Sequence(
          [
            hasLastKnown(),
            new RequestPathAction('playerPosition'),
            new SteerAction(),
            new Action('ClearInvestigation', (bb) => {
              bb.set<boolean>('hasLastKnown', false);
              bb.delete('currentPath');
              return Status.SUCCESS;
            }),
          ],
          { reactive: true },
        ),

        // 4. INVESTIGATE (direct fallback)
        new Sequence(
          [
            hasLastKnown(),
            moveDirectlyTo('InvestigateDirectly', 'playerPosition', (bb) => {
              bb.set<boolean>('hasLastKnown', false);
            }),
          ],
          { reactive: true },
        ),

        // 5. RETURN HOME (NavMesh)
        new Sequence([notAtHome(), new RequestPathAction('spawnPosition'), new SteerAction()], {
          reactive: true,
        }),

        // 6. RETURN HOME (direct fallback)
        new Sequence([notAtHome(), moveDirectlyTo('ReturnDirectly', 'spawnPosition')], {
          reactive: true,
        }),

        // 7. IDLE
        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'HeavyMixedRoot', reactive: true },
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private fireProjectile(self: EnemyControllerComponent, pos: vec3, target: vec3): void {
    // Prefer pool on own entity; fall back to named entity in scene
    const pool =
      (self.getOwner().getComponent('bullet_pool') as BulletPoolComponent | null) ??
      (Engine.getEntities()
        .getEntityByName('HeavyBulletManager')
        ?.getComponent('bullet_pool') as BulletPoolComponent | null);

    if (!pool) return;

    const bullet = pool.acquire();
    if (!bullet) return;

    const muzzle = vec3.fromValues(pos[0], pos[1] + MUZZLE_HEIGHT, pos[2]);
    const dir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), target, muzzle));
    const cap = self.getOwner().getComponent('capsule_collider') as CapsuleColliderComponent | null;
    bullet.fire(muzzle, dir, pool.release.bind(pool), cap?.getRigidBody());
  }

  // ── Message registration ──────────────────────────────────────────────────

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'heavy_mixed_controller', (comp) => {
      (comp as HeavyMixedController).onDeath();
    });
  }
}
