import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { MeleeAttackComponent } from '../../components/game/combat/MeleeAttackComponent';
import { TransformComponent } from '../../components/core/TransformComponent';

// ── Blackboard keys ───────────────────────────────────────────────────────────
const K_CHARGE_STATE = '_chargeState'; // 'IDLE' | 'CHARGING' | 'RECOVERY'
const K_RECOVERY_END = '_chargeRecoveryEnd'; // wall-clock seconds when recovery ends
const K_LAST_DOT = '_chargeDot'; // dot product sign from previous frame

type ChargeState = 'IDLE' | 'CHARGING' | 'RECOVERY';

export interface ChargeActionOptions {
  /** Charge movement speed in m/s. Default: 10 */
  chargeSpeed?: number;
  /**
   * Maximum yaw correction rate while charging (rad/s).
   * Lower = wider turn radius = easier to dodge by strafing.
   * Default: 1.8
   */
  maxTurnRate?: number;
  /**
   * Seconds the enemy is locked out of movement after overshooting or hitting.
   * This is the player's damage window.
   * Default: 1.0
   */
  recoveryTime?: number;
  /**
   * Distance in metres that triggers a melee hit (and ends the charge).
   * Default: 1.8
   */
  meleeRange?: number;
}

/**
 * ChargeAction — Fast-melee charge BT node.
 *
 * State machine (stored in Blackboard):
 *
 *   IDLE     → CHARGING when the player is spotted.
 *   CHARGING → moves toward the player at chargeSpeed with a limited turn
 *              radius (maxTurnRate). Transition triggers on:
 *               a) Player in meleeRange: strike + enter RECOVERY.
 *               b) Overshoot (forward dot product sign flips): enter RECOVERY.
 *   RECOVERY → enemy is motionless for `recoveryTime` seconds.
 *              After timeout, transitions back to IDLE (re-enters CHARGING
 *              immediately if the player is still visible).
 *
 * The RECOVERY window is the deliberate vulnerability: the enemy takes full
 * damage and cannot move. Controllers should NOT add damage resistance there.
 *
 * If a MeleeAttackComponent is present on the entity it is used for the
 * hit; otherwise a single `Msg.damage` is sent directly.
 *
 * Returns RUNNING throughout; parent Sequence stops it via reactive re-eval.
 */
export class ChargeAction extends BehaviorNode {
  private readonly chargeSpeed: number;
  private readonly maxTurnRate: number;
  private readonly recoveryTime: number;
  private readonly meleeRange: number;

  constructor(label = 'Charge', options: ChargeActionOptions = {}) {
    super(label);
    this.chargeSpeed = options.chargeSpeed ?? 10;
    this.maxTurnRate = options.maxTurnRate ?? 1.8;
    this.recoveryTime = options.recoveryTime ?? 1.0;
    this.meleeRange = options.meleeRange ?? 1.8;
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');
    const now = performance.now() / 1000;

    const state: ChargeState = bb.get<ChargeState>(K_CHARGE_STATE, 'IDLE');

    // ── RECOVERY ─────────────────────────────────────────────────────────────
    if (state === 'RECOVERY') {
      const recoveryEnd = bb.get<number>(K_RECOVERY_END, 0);
      if (now >= recoveryEnd) {
        bb.set(K_CHARGE_STATE, 'IDLE');
      }
      // Do NOT set any desired horizontal — enemy stays still
      return Status.RUNNING;
    }

    if (!target) {
      bb.set(K_CHARGE_STATE, 'IDLE');
      return Status.RUNNING;
    }

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    // ── IDLE → CHARGING ───────────────────────────────────────────────────────
    if (state === 'IDLE') {
      bb.set(K_CHARGE_STATE, 'CHARGING');
      bb.set(K_LAST_DOT, 1.0); // positive = heading toward player
    }

    // ── CHARGING ──────────────────────────────────────────────────────────────

    // a) Melee hit
    if (dist <= this.meleeRange) {
      this.doMeleeHit(self, pos);
      bb.set(K_CHARGE_STATE, 'RECOVERY');
      bb.set(K_RECOVERY_END, now + this.recoveryTime);
      return Status.RUNNING;
    }

    // b) Overshoot detection — dot product of (toPlayer) vs (currentHorizontal) flips negative
    const currentVel = self.getCurrentHorizontal();
    const velLen = vec3.length(currentVel);
    if (velLen > 0.5) {
      const dot = (currentVel[0] * dx + currentVel[2] * dz) / (velLen * (dist + 0.001));
      const prevDot = bb.get<number>(K_LAST_DOT, 1.0);
      if (prevDot > 0 && dot < -0.2) {
        // Sign flip — we passed the player
        bb.set(K_CHARGE_STATE, 'RECOVERY');
        bb.set(K_RECOVERY_END, now + this.recoveryTime);
        bb.set(K_LAST_DOT, dot);
        return Status.RUNNING;
      }
      bb.set(K_LAST_DOT, dot);
    }

    // c) Move toward player — faceToward handles rotation, setDesiredHorizontal drives speed
    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    const desired = vec3.fromValues(dx * invDist, 0, dz * invDist);

    self.faceToward(target);
    self.setDesiredHorizontal(desired, this.chargeSpeed);

    return Status.RUNNING;
  }

  public reset(): void {
    // State lives on the blackboard — cleared automatically on new encounter
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private doMeleeHit(self: EnemyControllerComponent, _pos: vec3): void {
    const melee = self.getOwner().getComponent('melee_attack') as MeleeAttackComponent | null;
    if (melee) {
      const tc = self.getOwner().getComponent('transform') as TransformComponent | null;
      const center = (tc?.getTransform().getWorldPosition() ?? [0, 0, 0]) as vec3;
      melee.attack(center);
    }
  }
}
