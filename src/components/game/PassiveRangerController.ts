import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, Status } from '../../ai/BehaviorNode';
import { Action, Condition, Selector, Sequence } from '../../ai';
import { Blackboard } from '../../ai/Blackboard';
import { FleeAction } from '../../ai/nodes/FleeAction';
import { FireOnlyAction } from '../../ai/nodes/FireOnlyAction';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { EnemyControllerComponentDataType } from '../../types/EnemyControllerComponentData.type';

/**
 * PassiveRangerController — Enemigo A: Rango Pasivo
 *
 * A slow, cowardly ranged enemy that maintains maximum distance from the
 * player and fires slow, wide projectiles at safe range.
 *
 * Behavior:
 *  - Runs away when the player is within 14 m (FleeAction)
 *  - Shoots once every 2 s when the player is >= 14 m away
 *  - Investigates last-known position when the player disappears
 *  - Idles otherwise
 *
 * Component key: 'passive_ranger_controller'
 */
export class PassiveRangerController extends EnemyControllerComponent {
  // ── Default stats ─────────────────────────────────────────────────────────

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 2.5,
      gravity: 9,
      acceleration: 8,
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

    // ── Direct movement helper ─────────────────────────────────────────────
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

    // ── Tree ──────────────────────────────────────────────────────────────
    return new Selector(
      [
        // 1. COMBAT — flee when player is close, shoot when at safe range
        //    FleeAction returns RUNNING while fleeing, SUCCESS at safe distance.
        //    FireOnlyAction only runs when FleeAction succeeds (safe distance).
        new Sequence(
          [
            canSee(),
            new FleeAction({ fleeRadius: 14, minFleeRadius: 10, lateralFlipInterval: 1.5 }),
            new FireOnlyAction({
              poolName: 'PassiveBlobManager',
              burstSize: 1,
              burstPause: 2.0,
              fireRate: 1,
              maxRange: 16,
            }),
          ],
          { reactive: true },
        ),

        // 2. INVESTIGATE — slow walk to last known player position
        new Sequence(
          [
            hasLastKnown(),
            moveDirectlyTo('InvestigateDirectly', 'playerPosition', (bb) => {
              bb.set<boolean>('hasLastKnown', false);
            }),
          ],
          { reactive: true },
        ),

        // 3. IDLE
        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'PassiveRangerRoot', reactive: true },
    );
  }

  // ── Message registration ──────────────────────────────────────────────────

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'passive_ranger_controller', (comp) => {
      (comp as PassiveRangerController).onDeath();
    });
    EnemyControllerComponent.registerDamagedHandler('passive_ranger_controller');
    EnemyControllerComponent.registerParryHitHandler('passive_ranger_controller');
  }
}
