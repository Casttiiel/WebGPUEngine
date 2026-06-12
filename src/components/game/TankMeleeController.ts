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

/**
 * TankMeleeController — Enemigo D: Melee Tanque
 *
 * Attack rhythm is fully controlled by CombatDirectorComponent (attackPaceMs,
 * aggressiveness). This controller only decides HOW to execute an attack once
 * the director grants the token — not WHEN.
 *
 * Flow:
 *   Director grants token → advance → attack → back off during recovery →
 *   release token → orbit until director grants next wave.
 */
export class TankMeleeController extends EnemyControllerComponent {
  // ── Per-attack transient state ─────────────────────────────────────────────
  /** True between attack() being called and recovery completing. */
  private _attackLaunched = false;

  /**
   * Per-tank cooldown after each attack, in milliseconds.
   * After releasing the token, this enemy won't be eligible for another
   * token (from the director or self) until this time has elapsed.
   * Director's global attackPaceMs applies ON TOP of this.
   */
  public individualCooldownMs = 3000;

  protected override getIndividualCooldownMs(): number {
    return this.individualCooldownMs;
  }

  // ── Orbit range (rebuilds BT on change via setter) ────────────────────────
  public get orbitRange(): number { return this._orbitRange; }
  public set orbitRange(v: number) {
    this._orbitRange = v;
    if (this.tree) this.tree = new BehaviorTree(this.buildTree(), this.bb);
  }
  private _orbitRange = 5;

  // ── Editor ────────────────────────────────────────────────────────────────
  private _editorFolder: any = null;

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
    const tank = this;

    const canSee = () =>
      new Condition('CanSeePlayer', (bb) => bb.get<boolean>('canSeePlayer', false));
    const notAtHome = () =>
      new Condition('NotAtHome', (bb) => {
        const pos = bb.get<vec3>('position');
        const spawn = bb.get<vec3>('spawnPosition');
        return !!pos && !!spawn && vec3.distance(pos, spawn) > 1.5;
      });

    // Token gate: director controls WHEN the next wave is allowed.
    // Enemy just says "I'm ready" — the director decides if now is the time.
    const tryToken = new Condition('TryToken', (_bb) => tank.tryAcquireAttackToken());

    // Advance, attack, back off through recovery, then signal done.
    // The director's pace timer starts when this resolves (via releaseToken below).
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
          // Back away during the post-swing window
          if (dist > 0.1) {
            const away = vec3.normalize(vec3.create(), vec3.negate(vec3.create(), dir));
            self.setDesiredHorizontal(away);
          }
          return Status.RUNNING;
        }
        // Recovery done (or was instant — recoveryTime=0): signal complete
        tank._attackLaunched = false;
        return Status.SUCCESS;
      }

      // Close in and swing
      if (dist > 0.3) {
        vec3.normalize(dir, dir);
        self.setDesiredHorizontal(dir);
      }
      if (melee && melee.canAttack(target, pos)) {
        const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
        const center = (tc?.getTransform().getWorldPosition() ?? pos) as vec3;
        melee.attack(center);
        tank._attackLaunched = true; // recovery check starts next tick
      }

      return Status.RUNNING;
    });

    // Release token → director starts the inter-wave pace timer.
    // No per-enemy cooldown here — rhythm is global.
    const releaseToken = new Action('ReleaseToken', (_bb) => {
      tank._attackLaunched = false;
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
        // 1. COMBAT
        // Outer Sequence reactive: canSee() re-checked every tick.
        // Inner Selector reactive: re-checks token availability every tick,
        //   so the enemy transitions to attacking the moment the director
        //   opens the next wave (pace timer expired).
        new Sequence(
          [
            canSee(),
            new Selector(
              [
                new Sequence([tryToken, advanceAndSwing, releaseToken]),
                new CircleStrafeAction({ preferredRange: tank._orbitRange }),
              ],
              { reactive: true },
            ),
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

  // ── Editor GUI ────────────────────────────────────────────────────────────

  public override renderInMenu(folder?: any): void {
    if (this._editorFolder || !folder) return;
    this._editorFolder = folder.addFolder('Tank Melee AI');
    this._editorFolder.open();

    this._editorFolder
      .add(this, 'individualCooldownMs', 0, 8000, 100)
      .name('Individual cooldown (ms)')
      .listen();

    // Orbit range uses a setter that rebuilds the BT so CircleStrafeAction picks it up.
    this._editorFolder
      .add(this, 'orbitRange', 1, 15, 0.5)
      .name('Orbit range (m)')
      .listen();
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
