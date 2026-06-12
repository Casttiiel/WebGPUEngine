import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, Status } from '../../ai/BehaviorNode';
import { Action, Condition, Selector, Sequence } from '../../ai';
import { Blackboard } from '../../ai/Blackboard';
import { MeleeAttackComponent } from './combat/MeleeAttackComponent';
import { TransformComponent } from '../core/TransformComponent';
import { CircleStrafeAction } from '../../ai/nodes/CircleStrafeAction';
import { RequestPathAction } from '../../ai/nodes/RequestPathAction';
import { SteerAction } from '../../ai/nodes/SteerAction';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

/**
 * TankMeleeController — Enemigo D: Melee Tanque
 *
 * A slow, heavily armoured enemy with very high HP and damage resistance.
 * Advances relentlessly toward the player and swings an AoE melee attack
 * whenever in range — MeleeAttackComponent handles the cooldown internally.
 *
 * Attack flow (with token system):
 *   1. Acquire attack token via makeTryTokenNode (subject to per-attack cooldown).
 *   2. Advance toward player and attack (advanceAndSwing).
 *   3. During recovery window: back away from player.
 *   4. Recovery ends → advanceAndSwing returns SUCCESS.
 *   5. releaseAndCooldown releases the token and sets a 2 s cooldown.
 *   6. During cooldown the enemy orbits (CircleStrafeAction).
 *
 * Component key: 'tank_melee_controller'
 */
export class TankMeleeController extends EnemyControllerComponent {
  // ── Per-attack state ──────────────────────────────────────────────────────
  /** True while the enemy is in the post-swing recovery backing-up phase. */
  private _wasInRecovery = false;
  /**
   * Timestamp (ms) before which the enemy must not attempt to acquire the
   * attack token again. Reset to 0 on load / respawn.
   */
  private _attackCooldownUntil = 0;

  // ── Default stats ─────────────────────────────────────────────────────────

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 2.0,
      gravity: 9,
      acceleration: 5,
      turnSpeed: 120,
      ...data,
    });
  }

  // ── Behavior Tree ─────────────────────────────────────────────────────────

  protected override buildTree(): BehaviorNode {
    const tank = this; // captured reference to TankMeleeController for closures

    const canSee = () =>
      new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false));
    const notAtHome = () =>
      new Condition('NotAtHome', (bb) => {
        const pos = bb.get<vec3>('position');
        const spawn = bb.get<vec3>('spawnPosition');
        return !!pos && !!spawn && vec3.distance(pos, spawn) > 1.5;
      });

    // Wraps the base tryToken check with a per-attack cooldown guard.
    // While cooldown is active the Sequence fails and the Selector falls
    // through to CircleStrafeAction, letting the enemy orbit instead.
    const tryTokenWithCooldown = new Condition('TryTokenCooldown', (_bb) => {
      if (Date.now() < tank._attackCooldownUntil) return false;
      return tank.tryAcquireAttackToken();
    });

    // Advance + swing.  Returns RUNNING while closing in and while in recovery.
    // Returns SUCCESS the frame recovery ends — this drives the Sequence forward
    // to releaseAndCooldown so the attack token is properly freed.
    const advanceAndSwing = new Action('TankAdvanceAndSwing', (bb) => {
      const self = bb.get<EnemyControllerComponent>('self')!;
      const pos = bb.get<vec3>('position')!;
      const target = bb.get<vec3>('playerPosition');
      if (!target) return Status.RUNNING;

      const dir = vec3.subtract(vec3.create(), target, pos);
      dir[1] = 0;
      const dist = vec3.length(dir);

      self.faceToward(target);

      const melee = self.getOwner().getComponent('melee_attack') as MeleeAttackComponent | null;

      if (melee?.isInRecovery()) {
        // Post-swing recovery: back away so the player has room to react
        tank._wasInRecovery = true;
        if (dist > 0.1) {
          const awayDir = vec3.normalize(vec3.create(), vec3.negate(vec3.create(), dir));
          self.setDesiredHorizontal(awayDir);
        }
        return Status.RUNNING;
      }

      if (tank._wasInRecovery) {
        // Recovery just ended this frame — signal attack complete
        tank._wasInRecovery = false;
        return Status.SUCCESS;
      }

      // Advance toward player and attempt swing
      if (dist > 0.3) {
        vec3.normalize(dir, dir);
        self.setDesiredHorizontal(dir);
      }
      if (melee && melee.canAttack(target, pos)) {
        const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
        const center = (tc?.getTransform().getWorldPosition() ?? pos) as vec3;
        melee.attack(center);
      }

      return Status.RUNNING;
    });

    // Runs after advanceAndSwing succeeds.  Releases the attack token and
    // starts a cooldown so other enemies get a turn before this one attacks again.
    const releaseAndCooldown = new Action('ReleaseToken', (_bb) => {
      tank.releaseAttackToken();
      tank._wasInRecovery = false;
      tank._attackCooldownUntil = Date.now() + 2000; // 2 s orbit cooldown
      return Status.SUCCESS;
    });

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
        // 1. COMBAT
        //    token + cooldown OK → advance, swing, release token, orbit cooldown
        //    no token or cooldown active → orbit at mid range
        new Sequence(
          [
            canSee(),
            new Selector([
              new Sequence([tryTokenWithCooldown, advanceAndSwing, releaseAndCooldown]),
              new CircleStrafeAction({ preferredRange: 5 }),
            ]),
          ],
          { reactive: true },
        ),

        // 2. RETURN HOME (NavMesh)
        new Sequence([notAtHome(), new RequestPathAction('spawnPosition'), new SteerAction()], {
          reactive: true,
        }),

        // 3. RETURN HOME (direct fallback)
        new Sequence([notAtHome(), moveDirectlyTo('ReturnDirectly', 'spawnPosition')], {
          reactive: true,
        }),

        // 4. IDLE
        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'TankMeleeRoot', reactive: true },
    );
  }

  // ── Message registration ──────────────────────────────────────────────────

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'tank_melee_controller', (comp) => {
      (comp as TankMeleeController).onDeath();
    });
    EnemyControllerComponent.registerDamagedHandler('tank_melee_controller');
    EnemyControllerComponent.registerParryHitHandler('tank_melee_controller');
  }
}
