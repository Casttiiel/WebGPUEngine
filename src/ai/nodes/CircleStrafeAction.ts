import { vec3 } from 'gl-matrix';
import { BehaviorNode, Status } from '../BehaviorNode';
import { Blackboard } from '../Blackboard';
import { EnemyControllerComponent } from '../../components/game/EnemyControllerComponent';

const K_STRAFE_DIR = '_csa_dir';        // +1 or -1 — current orbit direction
const K_STRAFE_FLIP = '_csa_flip';      // wall-clock seconds for next direction flip (idle oscillation)
const K_POS_TIME = '_csa_posTime';      // wall-clock seconds of last sector computation
const K_TARGET_ANGLE = '_csa_tAngle';   // target sector angle (radians, world space)

/**
 * CircleStrafeAction — Bloque 3 + 5.
 *
 * BT leaf que orbita al jugador a `preferredRange` mientras el enemigo espera
 * un token de ataque.
 *
 * Comportamiento por zona de distancia:
 *  - Demasiado cerca  (< rango × 0.7)  → retrocede lateralmente en strafe
 *  - En rango         (0.7 – 1.4 × r)  → órbita lateral pura a ¾ velocidad
 *  - Demasiado lejos  (> rango × 1.4)  → avanza diagonalmente en strafe
 *
 * Encirclement por sectores (Bloque 5):
 *  Cada 0.6 s calcula el ángulo del "mayor hueco" entre las posiciones angulares
 *  del resto de enemigos alrededor del jugador. El enemigo orbita hacia ese
 *  sector, espaciándose naturalmente sin coordinación explícita.
 *  Si ya está en el sector destino (|delta| < 0.15 rad), mantiene una pequeña
 *  oscilación natural para evitar que todos estén perfectamente alineados.
 *
 * Siempre devuelve RUNNING — la Sequence reactiva exterior lo interrumpe cuando
 * el enemigo pierde al jugador de vista o adquiere su token de ataque.
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

    self.faceToward(target);

    const invDist = dist > 0.001 ? 1.0 / dist : 0;
    // Forward vector (self → player)
    const fwdX = dx * invDist;
    const fwdZ = dz * invDist;
    // Right vector (90° CW of forward in XZ): rightX = fwdZ, rightZ = -fwdX
    const rightX = fwdZ;
    const rightZ = -fwdX;

    // ── Sector targeting — recomputed every 0.6 s ─────────────────────────────
    const posTime = bb.get<number>(K_POS_TIME, -9999);
    let targetAngle = bb.get<number>(K_TARGET_ANGLE, Infinity);
    if (targetAngle === Infinity || now - posTime >= 0.6) {
      bb.set(K_POS_TIME, now);
      targetAngle = this.computeTargetSectorAngle(self, target, pos);
      bb.set(K_TARGET_ANGLE, targetAngle);
    }

    // ── Determine orbital direction from angular delta ────────────────────────
    const currentAngle = Math.atan2(pos[0] - target[0], pos[2] - target[2]);
    let angleDelta = targetAngle - currentAngle;
    while (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
    while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

    let dir: number;
    if (Math.abs(angleDelta) < 0.15) {
      // In target sector — small natural oscillation to avoid static positions
      dir = bb.get<number>(K_STRAFE_DIR, 1);
      const flipTime = bb.get<number>(K_STRAFE_FLIP, -9999);
      if (now >= flipTime) {
        dir = -dir;
        bb.set(K_STRAFE_DIR, dir);
        bb.set(K_STRAFE_FLIP, now + 1.5 + Math.random() * 1.0);
      }
    } else {
      // Orbit toward target sector:
      // angleDelta > 0 → target is CCW → move left (-right)  → dir = -1
      // angleDelta < 0 → target is CW  → move right (+right) → dir = +1
      dir = angleDelta > 0 ? -1 : 1;
      bb.set(K_STRAFE_DIR, dir);
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
      const dir3 = vec3.fromValues(moveX / len, 0, moveZ / len);
      self.setDesiredHorizontal(dir3, self.getMoveSpeed() * speedFactor);
    }

    return Status.RUNNING;
  }

  /**
   * Computes the angle (radians) of the largest angular gap between the other
   * enemies' positions around the player.  Returns the center of that gap so
   * this enemy orbits toward the emptiest sector, creating emergent encirclement.
   *
   * If alone, returns the current self angle (no repositioning needed).
   * Recomputed every 0.6 s to avoid per-frame registry scans.
   */
  private computeTargetSectorAngle(
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
      if (ddx * ddx + ddz * ddz < 0.25) continue; // ignore enemies stacked on player
      others.push(Math.atan2(ddx, ddz));
    }

    const selfAngle = Math.atan2(selfPos[0] - playerPos[0], selfPos[2] - playerPos[2]);

    if (others.length === 0) return selfAngle;

    // Sort angles and find the largest gap
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

    // Normalize to [-π, π]
    while (bestGapCenter > Math.PI) bestGapCenter -= 2 * Math.PI;
    while (bestGapCenter < -Math.PI) bestGapCenter += 2 * Math.PI;

    return bestGapCenter;
  }

  public reset(): void {
    // BT node is stateless — all state lives in the Blackboard
  }
}
