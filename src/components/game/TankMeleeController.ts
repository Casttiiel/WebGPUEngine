import { vec3 } from 'gl-matrix';
import { EnemyControllerComponent } from './EnemyControllerComponent';
import { BehaviorNode, BehaviorTree, Status } from '../../ai';
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

export class TankMeleeController extends EnemyControllerComponent {
  // ── Per-attack transient state ─────────────────────────────────────────────
  private _attackLaunched = false;

  // ── Tier 3.14 — deliberate imperfection ──────────────────────────────────
  // 15% chance per attack cycle of a 0.3–0.7 s hesitation before advancing.
  private _hesitateRolled = false;
  private _hesitateUntil = 0;

  public individualCooldownMs = 3000;

  protected override getIndividualCooldownMs(): number {
    return this.individualCooldownMs;
  }

  public override getAttackThreatCost(): number {
    return 40;
  }

  // ── Orbit range (rebuilds BT on change via setter) ────────────────────────
  public get orbitRange(): number { return this._orbitRange; }
  public set orbitRange(v: number) {
    this._orbitRange = v;
    if (this.tree) this.tree = new BehaviorTree(this.buildTree(), this.bb);
  }
  private _orbitRange = 5;

  private _editorFolder: any = null;

  public override async load(data: EnemyControllerComponentDataType): Promise<void> {
    await super.load({
      moveSpeed: 2.0,
      gravity: 9,
      acceleration: 5,
      turnSpeed: 120,
      ...data,
    });
  }

  protected override buildTree(): BehaviorNode {
    const tank = this;

    const canSee = () =>
      new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false));
    const notAtHome = () =>
      new Condition('NotAtHome', (bb) => {
        const pos = bb.get<vec3>('position');
        const spawn = bb.get<vec3>('spawnPosition');
        return !!pos && !!spawn && vec3.distance(pos, spawn) > 1.5;
      });

    const tryToken = new Condition('TryToken', (_bb) => tank.tryAcquireAttackToken());

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

      if (tank._attackLaunched) {
        if (melee?.isInRecovery()) {
          if (dist > 0.1) {
            const away = vec3.normalize(vec3.create(), vec3.negate(vec3.create(), dir));
            self.setDesiredHorizontal(away);
          }
          return Status.RUNNING;
        }
        tank._attackLaunched = false;
        return Status.SUCCESS;
      }

      // Tier 3.14 — roll for hesitation once at the start of each attack cycle
      if (!tank._hesitateRolled) {
        tank._hesitateRolled = true;
        if (Math.random() < 0.15) {
          tank._hesitateUntil = Date.now() + 300 + Math.random() * 400;
        }
      }
      if (Date.now() < tank._hesitateUntil) {
        return Status.RUNNING; // face player but don't advance yet
      }

      if (dist > 0.3) {
        vec3.normalize(dir, dir);
        self.setDesiredHorizontal(dir);
      }
      if (melee && melee.canAttack(target, pos)) {
        const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
        const center = (tc?.getTransform().getWorldPosition() ?? pos) as vec3;
        melee.attack(center);
        tank._attackLaunched = true;
      }

      return Status.RUNNING;
    });

    const releaseToken = new Action('ReleaseToken', (_bb) => {
      tank._attackLaunched = false;
      tank._hesitateRolled = false;
      tank._hesitateUntil = 0;
      tank.releaseAttackToken();
      return Status.SUCCESS;
    });

    const moveDirectlyTo = (label: string, targetKey: string, onArrival?: (bb: Blackboard) => void) =>
      new Action(label, (bb) => {
        const self = bb.get<EnemyControllerComponent>('self')!;
        const pos = bb.get<vec3>('position')!;
        const target = bb.get<vec3>(targetKey)!;
        const d = vec3.subtract(vec3.create(), target, pos);
        d[1] = 0;
        if (vec3.length(d) < 1.5) { onArrival?.(bb); return Status.SUCCESS; }
        vec3.normalize(d, d);
        self.setDesiredHorizontal(d);
        self.faceToward(target);
        return Status.RUNNING;
      });

    return new Selector(
      [
        new Sequence(
          [
            canSee(),
            new Selector(
              [
                new Sequence([tryToken, advanceAndSwing, releaseToken]),
                new CircleStrafeAction({
                  preferredRangeMin: tank._orbitRange * 0.8,
                  preferredRangeMax: tank._orbitRange * 1.2,
                }),
              ],
              { reactive: true },
            ),
          ],
          { reactive: true },
        ),

        new Sequence([notAtHome(), new RequestPathAction('spawnPosition'), new SteerAction()], {
          reactive: true,
        }),

        new Sequence([notAtHome(), moveDirectlyTo('ReturnDirectly', 'spawnPosition')], {
          reactive: true,
        }),

        new Action('Idle', (_bb) => Status.RUNNING),
      ],
      { label: 'TankMeleeRoot', reactive: true },
    );
  }

  public override renderInMenu(folder?: any): void {
    if (this._editorFolder || !folder) return;
    this._editorFolder = folder.addFolder('Tank Melee AI');
    this._editorFolder.open();

    this._editorFolder
      .add(this, 'individualCooldownMs', 0, 8000, 100)
      .name('Individual cooldown (ms)')
      .listen();

    this._editorFolder
      .add(this, 'orbitRange', 1, 15, 0.5)
      .name('Orbit range (m)')
      .listen();
  }

  public static override registerMsgs(): void {
    MsgDispatcher.register(MsgType.ON_DEATH, 'tank_melee_controller', (comp) => {
      (comp as TankMeleeController).onDeath();
    });
    EnemyControllerComponent.registerDamagedHandler('tank_melee_controller');
    EnemyControllerComponent.registerParryHitHandler('tank_melee_controller');
  }
}
