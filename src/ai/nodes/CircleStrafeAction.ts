import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';

const K_STRAFE_DIR = '_csa_dir';     // +1 or -1
const K_STRAFE_FLIP = '_csa_flip';   // wall-clock seconds for next direction flip
const K_POS_SIDE = '_csa_side';      // last computed positioning push (-1, 0, +1)
const K_POS_TIME = '_csa_posTime';   // wall-clock seconds of last positioning check

/**
 * CircleStrafeAction
 *
 * BT leaf that orbits the player at `preferredRange` while the enemy waits for
 * an attack token.  Behavior by distance:
 *
 *  - Too close (< range × 0.7)  → back off diagonally while strafing
 *  - In range   (0.7 – 1.4 × r) → pure lateral orbit at ¾ speed
 *  - Too far    (> range × 1.4) → approach diagonally while strafing
 *
 * Positioning intent: every 0.6 s checks nearby enemies and biases the strafe
 * direction toward the less-populated side, naturally spacing the group out.
 *
 * Always returns RUNNING — the outer reactive Sequence interrupts it the moment
 * the enemy either loses sight of the player or acquires its attack token.
 */
export class CircleStrafeAction extends BehaviorNode {
  private readonly preferredRange: number;

  constructor(options: { preferredRange?: number } = {}) {
    super('CircleStrafe');
    this.preferredRange = options.preferredRange ?? 6;
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');
    if (!target) return Status.RUNNING;

    const now = performance.now() / 1000;

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Always face the player
    self.faceToward(target);

    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    // Forward vector (self → player)
    const fwdX = dx * invDist;
    const fwdZ = dz * invDist;
    // Right vector (90° CW): right = (fwdZ, 0, -fwdX)
    const rightX = fwdZ;
    const rightZ = -fwdX;

    // ── Strafe direction with periodic flips ─────────────────────────────────
    let dir = bb.get<number>(K_STRAFE_DIR, 1);
    const flipTime = bb.get<number>(K_STRAFE_FLIP, -9999);
    if (now >= flipTime) {
      dir = -dir;
      bb.set(K_STRAFE_DIR, dir);
      bb.set(K_STRAFE_FLIP, now + 1.5 + Math.random() * 1.0); // 1.5–2.5 s
    }

    // ── Positioning intent: bias toward less-populated side ───────────────────
    let posSide = bb.get<number>(K_POS_SIDE, 0);
    const posTime = bb.get<number>(K_POS_TIME, -9999);
    if (now - posTime >= 0.6) {
      bb.set(K_POS_TIME, now);
      posSide = this.computePositioningSide(self, pos, rightX, rightZ);
      bb.set(K_POS_SIDE, posSide);
    }

    // If positioning pushes opposite our current strafing direction, flip
    if (posSide !== 0 && posSide !== dir) {
      dir = posSide;
      bb.set(K_STRAFE_DIR, dir);
      bb.set(K_STRAFE_FLIP, now + 1.0 + Math.random() * 0.5);
    }

    // ── Build movement vector based on distance zone ──────────────────────────
    let moveX: number;
    let moveZ: number;
    let speedFactor: number;

    const tooClose = this.preferredRange * 0.7;
    const tooFar = this.preferredRange * 1.4;

    if (dist < tooClose) {
      // Back off + strafe: 60% backward, 80% lateral
      moveX = -fwdX * 0.6 + rightX * dir * 0.8;
      moveZ = -fwdZ * 0.6 + rightZ * dir * 0.8;
      speedFactor = 0.9;
    } else if (dist > tooFar) {
      // Approach + strafe: 70% forward, 70% lateral
      moveX = fwdX * 0.7 + rightX * dir * 0.7;
      moveZ = fwdZ * 0.7 + rightZ * dir * 0.7;
      speedFactor = 0.85;
    } else {
      // Pure lateral orbit
      moveX = rightX * dir;
      moveZ = rightZ * dir;
      speedFactor = 0.75;
    }

    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0.001) {
      const normX = moveX / len;
      const normZ = moveZ / len;
      const dir3 = vec3.fromValues(normX, 0, normZ);
      self.setDesiredHorizontal(dir3, self.getMoveSpeed() * speedFactor);
    }

    return Status.RUNNING;
  }

  /**
   * Returns the less-populated side (+1 right / -1 left / 0 balanced) by
   * comparing how many nearby enemies are on each side relative to self→player axis.
   * Checked every 0.6 s to avoid per-frame registry scans.
   */
  private computePositioningSide(
    self: EnemyControllerComponent,
    pos: vec3,
    rightX: number,
    rightZ: number,
  ): number {
    let rightCount = 0;
    let leftCount = 0;

    for (const ec of EnemyControllerComponent.getAll()) {
      if (ec === self) continue;
      const nbPos = ec.bb.get<vec3>('position');
      if (!nbPos) continue;

      const toOtherX = nbPos[0] - pos[0];
      const toOtherZ = nbPos[2] - pos[2];
      const d = Math.sqrt(toOtherX * toOtherX + toOtherZ * toOtherZ);
      if (d < 0.01 || d > 10) continue;

      // Dot with right axis: positive = enemy is on our right side
      const dot = (toOtherX / d) * rightX + (toOtherZ / d) * rightZ;
      if (dot > 0.3) rightCount++;
      else if (dot < -0.3) leftCount++;
    }

    if (rightCount > leftCount) return -1; // push left
    if (leftCount > rightCount) return 1;  // push right
    return 0;
  }

  public reset(): void {
    // BT node is stateless — all state lives in the Blackboard
  }
}
