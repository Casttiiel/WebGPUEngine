import { vec3 } from 'gl-matrix';

/**
 * CombatSlotManager — Tier 4.15: Positional slot system.
 *
 * Maintains N evenly-spaced slots around the player. Orbiting enemies reserve
 * a slot and navigate toward it, preventing formation overlap and making
 * combat geometry readable for the player.
 *
 * Uses opaque object keys so it doesn't import EnemyControllerComponent —
 * avoids any circular dependency with CircleStrafeAction.
 *
 * Lifetime: created by CombatDirectorComponent, exposed via static instance.
 */
export class CombatSlotManager {
  public static instance: CombatSlotManager | null = null;

  private readonly numSlots: number;
  private readonly radius: number;
  private readonly _positions: vec3[];
  private readonly _assignments = new Map<object, number>();

  constructor(numSlots: number = 8, radius: number = 7.0) {
    this.numSlots = numSlots;
    this.radius = radius;
    this._positions = Array.from({ length: numSlots }, () => vec3.create());
  }

  /**
   * Recompute all slot world positions around `playerPos`.
   * Called once per frame from CombatDirectorComponent.update().
   */
  public update(playerPos: vec3): void {
    for (let i = 0; i < this.numSlots; i++) {
      const angle = (i / this.numSlots) * 2 * Math.PI;
      const p = this._positions[i]!;
      p[0] = playerPos[0] + Math.sin(angle) * this.radius;
      p[1] = playerPos[1];
      p[2] = playerPos[2] + Math.cos(angle) * this.radius;
    }
  }

  /**
   * Returns the world position of the slot assigned to `holder`.
   * Assigns the nearest free slot on first call.
   * Returns null when all slots are occupied (enemy falls back to organic orbit).
   *
   * @param holder  The orbiting enemy (any object — used as Map key).
   * @param holderPos  Current world position of the holder.
   */
  public getOrAssignSlot(holder: object, holderPos: vec3): vec3 | null {
    const existing = this._assignments.get(holder);
    if (existing !== undefined) {
      return this._positions[existing] ?? null;
    }

    const usedSlots = new Set(this._assignments.values());
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < this.numSlots; i++) {
      if (usedSlots.has(i)) continue;
      const d = vec3.distance(holderPos, this._positions[i]!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return null;
    this._assignments.set(holder, bestIdx);
    return this._positions[bestIdx]!;
  }

  /** Free the slot held by `holder`. Call when the enemy starts attacking or dies. */
  public releaseSlot(holder: object): void {
    this._assignments.delete(holder);
  }

  public clear(): void {
    this._assignments.clear();
  }
}
