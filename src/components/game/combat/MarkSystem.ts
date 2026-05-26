/**
 * MarkSystem — Tracks which enemies are currently marked by the Lynx.
 *
 * Marks are stored as entity-ID → expiry timestamp pairs.
 * A mark with expiry <= 0 is treated as permanent until cleared explicitly.
 *
 * Usage:
 *   const marks = new MarkSystem();
 *   marks.markEnemy(entityId, 15); // mark for 15 seconds
 *   marks.isMarked(entityId);      // true while active
 *   marks.update(deltaTime);       // call every frame to tick expiry
 */
export class MarkSystem {
  /** entityId → remaining mark duration in seconds (Infinity = permanent) */
  private readonly marks: Map<number, number> = new Map();

  /**
   * Mark an enemy entity for the given duration (seconds).
   * If the entity is already marked, the timer is reset to the new duration.
   * Pass Infinity for a permanent mark.
   */
  public markEnemy(entityId: number, duration: number): void {
    this.marks.set(entityId, duration);
  }

  /** Returns true if the entity is currently marked. */
  public isMarked(entityId: number): boolean {
    return this.marks.has(entityId);
  }

  /** Remove a mark immediately (e.g. on enemy death or after dash hit). */
  public clearMark(entityId: number): void {
    this.marks.delete(entityId);
  }

  /** Tick all active marks, removing expired ones. Call once per frame. */
  public update(deltaTime: number): void {
    for (const [id, remaining] of this.marks) {
      if (remaining === Infinity) continue;
      const next = remaining - deltaTime;
      if (next <= 0) {
        this.marks.delete(id);
      } else {
        this.marks.set(id, next);
      }
    }
  }

  /** Returns remaining time for a mark, or 0 if not marked. */
  public getRemainingTime(entityId: number): number {
    return this.marks.get(entityId) ?? 0;
  }

  /** Number of currently active marks. */
  public getMarkedCount(): number {
    return this.marks.size;
  }
}
