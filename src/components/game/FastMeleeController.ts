import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, Status } from '../../ai/BehaviorNode';
import { Action, Condition, Selector, Sequence } from '../../ai';
import { Blackboard } from '../../ai/Blackboard';
import { ChargeAction } from '../../ai/nodes/ChargeAction';
import { CircleStrafeAction } from '../../ai/nodes/CircleStrafeAction';
import { RequestPathAction } from '../../ai/nodes/RequestPathAction';
import { SteerAction } from '../../ai/nodes/SteerAction';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

/**
 * FastMeleeController — Enemigo C: Melee Rápido
 *
 * A fast, fragile melee enemy that charges the player in a straight line.
 * Limited turn radius makes it easy to dodge by strafing sideways; overshooting
 * the player triggers a recovery window (locked movement) which is the intended
 * damage opportunity for the player.
 *
 * Requires `MeleeAttackComponent` on the same entity — ChargeAction invokes it
 * automatically when within `meleeRange`.
 *
 * Component key: 'fast_melee_controller'
 */
export class FastMeleeController extends EnemyControllerComponent {
  // ── Default stats ─────────────────────────────────────────────────────────

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 10,
      gravity: 9,
      acceleration: 20,
      turnSpeed: 360,
      ...data,
    });
  }

  // ── Behavior Tree ─────────────────────────────────────────────────────────

  protected override buildTree(): BehaviorNode {
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
        // 1. COMBAT — token granted → charge; no token → circle strafe at close range
        new Sequence(
          [
            canSee(),
            new Selector([
              new Sequence([
                this.makeTryTokenNode(),
                new ChargeAction('Charge', {
                  chargeSpeed: 10,
                  maxTurnRate: 1.8,
                  recoveryTime: 1.0,
                  meleeRange: 1.5,
                }),
              ]),
              new CircleStrafeAction({ preferredRange: 4 }),
            ]),
          ],
          { reactive: true },
        ),

        // 2. INVESTIGATE (NavMesh)
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

        // 3. INVESTIGATE (direct fallback)
        new Sequence(
          [
            hasLastKnown(),
            moveDirectlyTo('InvestigateDirectly', 'playerPosition', (bb) => {
              bb.set<boolean>('hasLastKnown', false);
            }),
          ],
          { reactive: true },
        ),

        // 4. RETURN HOME (NavMesh)
        new Sequence([notAtHome(), new RequestPathAction('spawnPosition'), new SteerAction()], {
          reactive: true,
        }),

        // 5. RETURN HOME (direct fallback)
        new Sequence([notAtHome(), moveDirectlyTo('ReturnDirectly', 'spawnPosition')], {
          reactive: true,
        }),

        // 6. IDLE
        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'FastMeleeRoot', reactive: true },
    );
  }

  // ── Message registration ──────────────────────────────────────────────────

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'fast_melee_controller', (comp) => {
      (comp as FastMeleeController).onDeath();
    });
    EnemyControllerComponent.registerDamagedHandler('fast_melee_controller');
    EnemyControllerComponent.registerParryHitHandler('fast_melee_controller');
  }
}
