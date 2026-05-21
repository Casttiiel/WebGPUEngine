import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, Status } from '../../ai/BehaviorNode';
import { Action, Condition, Selector, Sequence } from '../../ai';
import { Blackboard } from '../../ai/Blackboard';
import { MeleeAttackComponent } from './combat/MeleeAttackComponent';
import { TransformComponent } from '../core/TransformComponent';
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
 * Counter-play: the WeakPoint child entity (sphere collider + WeakPointComponent)
 * amplifies 5× any direct hit. Players should aim precisely at it to bypass
 * the base damage resistance.
 *
 * `damageResistance` is configured on the HealthComponent in the prefab
 * (not on this class), using the standard HealthComponent scaling.
 *
 * Component key: 'tank_melee_controller'
 */
export class TankMeleeController extends EnemyControllerComponent {
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
    const canSee = () =>
      new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false));
    const notAtHome = () =>
      new Condition('NotAtHome', (bb) => {
        const pos = bb.get<vec3>('position');
        const spawn = bb.get<vec3>('spawnPosition');
        return !!pos && !!spawn && vec3.distance(pos, spawn) > 1.5;
      });

    // Advance toward the player and swing AoE melee when in range.
    // The tank never stops — MeleeAttackComponent manages its own cooldown.
    const advanceAndSwing = new Action('TankAdvanceAndSwing', (bb) => {
      const self = bb.get<EnemyControllerComponent>('self')!;
      const pos = bb.get<vec3>('position')!;
      const target = bb.get<vec3>('playerPosition');
      if (!target) return Status.RUNNING;

      const dir = vec3.subtract(vec3.create(), target, pos);
      dir[1] = 0;
      const dist = vec3.length(dir);

      self.faceToward(target);

      if (dist > 0.3) {
        vec3.normalize(dir, dir);
        self.setDesiredHorizontal(dir);
      }

      // Attempt AoE swing — MeleeAttackComponent handles range check + cooldown
      const melee = self.getOwner().getComponent('melee_attack') as MeleeAttackComponent | null;
      if (melee && melee.canAttack(target, pos)) {
        const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
        const center = (tc?.getTransform().getWorldPosition() ?? pos) as vec3;
        melee.attack(center);
      }

      return Status.RUNNING;
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
        // 1. COMBAT — advance relentlessly, AoE swing when close enough
        new Sequence([canSee(), advanceAndSwing], { reactive: true }),

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
  }
}
