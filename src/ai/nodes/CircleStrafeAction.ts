import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';
import { CombatSlotManager } from '../CombatSlotManager';

// ── Blackboard keys (prefixed to avoid collisions) ────────────────────────────
const K_STRAFE_DIR    = '_csa_dir';        // +1 or -1 — current orbit direction
const K_STRAFE_FLIP   = '_csa_flip';       // wall-clock s for next direction flip
const K_POS_TIME      = '_csa_posTime';    // wall-clock s of last sector computation
const K_POS_INTERVAL  = '_csa_posIval';    // randomised slot-reservation interval (s)
const K_TARGET_ANGLE  = '_csa_tAngle';     // target sector angle (rad, world space)
const K_NOISE_ANGLE   = '_csa_noise';      // random angular offset applied to target (rad)
const K_NOISE_TIME    = '_csa_noiseT';     // wall-clock s of last noise refresh
const K_NOISE_INTERVAL = '_csa_noiseIval'; // randomised noise-refresh interval (s)
const K_ORBIT_PAUSE   = '_csa_pause';      // wall-clock s until orbit hesitation ends

/**
 * CircleStrafeAction — orbit the player while waiting for an attack token.
 *
 * Tier 1 improvements:
 *  3. Position noise    — ±15° angular offset refreshed every 4-8 s.
 *  4. Variable range    — constructor accepts [preferredRangeMin, preferredRangeMax].
 *  5. Commitment time   — oscillation direction locked 1.5–4 s.
 *
 * Tier 2 improvement:
 *  7. Slot reservation  — sector recalculated every 2–4 s.
 *
 * Tier 3.14 improvement:
 *  Orbit hesitation — 20% chance per noise refresh to pause 0.4–1.2 s.
 *  Breaks the "constant uniform orbit" look; enemies occasionally pause and reposition.
 *
 * Tier 4.15 improvement:
 *  Slot system integration — if CombatSlotManager has a slot assigned, steer toward
 *  that world position instead of computing the largest gap organically.
 *  Falls back to organic gap-finding when no slot manager is active.
 */
export class CircleStrafeAction extends BehaviorNode {
  private readonly preferredRange: number;

  /** Cached self reference for slot release in reset(). */
  private _self: EnemyControllerComponent | null = null;

  constructor(options: {
    preferredRange?: number;
    preferredRangeMin?: number;
    preferredRangeMax?: number;
  } = {}) {
    super('CircleStrafe');
    const lo = options.preferredRangeMin ?? options.preferredRange ?? 6;
    const hi = options.preferredRangeMax ?? options.preferredRange ?? lo;
    this.preferredRange = lo + Math.random() * (hi - lo);
  }

  public tick(bb: Blackboard): Status {
    const self = bb.get<EnemyControllerComponent>('self')!;
    const pos = bb.get<vec3>('position')!;
    const target = bb.get<vec3>('playerPosition');
    if (!target) return Status.RUNNING;

    this._self = self;

    const now = performance.now() / 1000;

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    self.faceToward(target);

    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    const fwdX = dx * invDist;
    const fwdZ = dz * invDist;
    const rightX =  fwdZ;
    const rightZ = -fwdX;

    // ── Tier 1.3 + 3.14 — Noise refresh + orbit hesitation ───────────────────
    const noiseTime = bb.get<number>(K_NOISE_TIME, -9999);
    let noiseInterval = bb.get<number>(K_NOISE_INTERVAL, 0);
    let noiseAngle = bb.get<number>(K_NOISE_ANGLE, 0);

    if (now - noiseTime >= noiseInterval) {
      noiseInterval = 4.0 + Math.random() * 4.0; // 4–8 s
      noiseAngle = (Math.random() - 0.5) * (Math.PI / 6); // ±15°
      bb.set(K_NOISE_TIME, now);
      bb.set(K_NOISE_INTERVAL, noiseInterval);
      bb.set(K_NOISE_ANGLE, noiseAngle);

      // Tier 3.14 — orbit hesitation: 20% chance of a brief pause (0.4–1.2 s)
      if (Math.random() < 0.2) {
        bb.set(K_ORBIT_PAUSE, now + 0.4 + Math.random() * 0.8);
      }
    }

    // Tier 3.14 — pause orbit (enemy freezes briefly, then repositions)
    const orbitPause = bb.get<number>(K_ORBIT_PAUSE, 0);
    if (now < orbitPause) {
      return Status.RUNNING; // face player via faceToward above, but don't move
    }

    // ── Tier 2.7 — Slot reservation with randomised interval ─────────────────
    const posTime = bb.get<number>(K_POS_TIME, -9999);
    let posInterval = bb.get<number>(K_POS_INTERVAL, 0);
    let targetAngle = bb.get<number>(K_TARGET_ANGLE, Infinity);

    if (targetAngle === Infinity || now - posTime >= posInterval) {
      posInterval = 2.0 + Math.random() * 2.0; // 2–4 s
      bb.set(K_POS_TIME, now);
      bb.set(K_POS_INTERVAL, posInterval);
      targetAngle = this.computeTargetAngle(self, target, pos);
      bb.set(K_TARGET_ANGLE, targetAngle);
    }

    const noisedTarget = targetAngle + noiseAngle;

    // ── Determine orbital direction from angular delta ────────────────────────
    const currentAngle = Math.atan2(pos[0] - target[0], pos[2] - target[2]);
    let angleDelta = noisedTarget - currentAngle;
    while (angleDelta >  Math.PI) angleDelta -= 2 * Math.PI;
    while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

    let dir: number;
    if (Math.abs(angleDelta) < 0.15) {
      // Tier 1.5 — commitment time: 1.5–4 s
      dir = bb.get<number>(K_STRAFE_DIR, 1);
      const flipTime = bb.get<number>(K_STRAFE_FLIP, -9999);
      if (now >= flipTime) {
        dir = -dir;
        bb.set(K_STRAFE_DIR, dir);
        bb.set(K_STRAFE_FLIP, now + 1.5 + Math.random() * 2.5);
      }
    } else {
      dir = angleDelta > 0 ? -1 : 1;
      bb.set(K_STRAFE_DIR, dir);
    }

    // ── Movement based on distance zone ──────────────────────────────────────
    const tooClose = this.preferredRange * 0.7;
    const tooFar   = this.preferredRange * 1.4;

    let moveX: number;
    let moveZ: number;
    let speedFactor: number;

    if (dist < tooClose) {
      moveX = -fwdX * 0.6 + rightX * dir * 0.8;
      moveZ = -fwdZ * 0.6 + rightZ * dir * 0.8;
      speedFactor = 0.9;
    } else if (dist > tooFar) {
      moveX = fwdX * 0.7 + rightX * dir * 0.7;
      moveZ = fwdZ * 0.7 + rightZ * dir * 0.7;
      speedFactor = 0.85;
    } else {
      moveX = rightX * dir;
      moveZ = rightZ * dir;
      speedFactor = 0.75;
    }

    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0.001) {
      const dir3 = vec3.fromValues(moveX / len, 0, moveZ / len);
      self.setDesiredHorizontal(dir3, self.getMoveSpeed() * speedFactor);
    }

    return Status.RUNNING;
  }

  /**
   * Computes the target orbit angle using one of two strategies:
   *   1. Slot system (Tier 4.15): if CombatSlotManager has a slot, steer toward it.
   *   2. Organic gap-finding: find the largest angular gap between other enemies.
   */
  private computeTargetAngle(
    self: EnemyControllerComponent,
    playerPos: vec3,
    selfPos: vec3,
  ): number {
    // Tier 4.15 — prefer slot-based positioning when available
    const slotMgr = CombatSlotManager.instance;
    if (slotMgr) {
      const slotPos = slotMgr.getOrAssignSlot(self, selfPos);
      if (slotPos) {
        const sdx = slotPos[0] - playerPos[0];
        const sdz = slotPos[2] - playerPos[2];
        return Math.atan2(sdx, sdz);
      }
    }

    // Fallback: organic largest-gap algorithm
    return this.computeGapAngle(self, playerPos, selfPos);
  }

  private computeGapAngle(
    self: EnemyControllerComponent,
    playerPos: vec3,
    selfPos: vec3,
  ): number {
    const others: number[] = [];

    for (const ec of EnemyControllerComponent.getAll()) {
      if (ec === self) continue;
      const nbPos = ec.bb.get<vec3>('position');
      if (!nbPos) continue;
      const ddx = nbPos[0] - playerPos[0];
      const ddz = nbPos[2] - playerPos[2];
      if (ddx * ddx + ddz * ddz < 0.25) continue;
      others.push(Math.atan2(ddx, ddz));
    }

    const selfAngle = Math.atan2(selfPos[0] - playerPos[0], selfPos[2] - playerPos[2]);
    if (others.length === 0) return selfAngle;

    const sorted = [...others].sort((a, b) => a - b);
    let bestGapSize = 0;
    let bestGapCenter = selfAngle;

    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const b = i < sorted.length - 1 ? sorted[i + 1]! : sorted[0]! + 2 * Math.PI;
      const gap = b - a;
      if (gap > bestGapSize) {
        bestGapSize = gap;
        bestGapCenter = a + gap / 2;
      }
    }

    while (bestGapCenter >  Math.PI) bestGapCenter -= 2 * Math.PI;
    while (bestGapCenter < -Math.PI) bestGapCenter += 2 * Math.PI;
    return bestGapCenter;
  }

  public reset(): void {
    // Release the slot reservation so the next orbit re-assigns cleanly.
    if (this._self) {
      CombatSlotManager.instance?.releaseSlot(this._self);
      this._self = null;
    }
  }
}
