import { vec3, vec4 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import type { CameraComponent } from '../../render/CameraComponent';
import type { TransformComponent } from '../../core/TransformComponent';

/** World-space units above the enemy transform used for the billboard Y position. */
const MARK_Y_OFFSET = 2.3;
/** Small Y bump so world-mark billboards float above the surface hit point. */
const WORLD_MARK_Y_OFFSET = 0.4;

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
 *   marks.updateNDC(camera);       // call after update() to precompute screen positions
 */
export class MarkSystem {
  /** entityId → remaining mark duration in seconds (Infinity = permanent) */
  private readonly marks: Map<number, number> = new Map();

  // World-space marks — stuck on surfaces, dashing into them resets cooldown
  private readonly worldMarks: Array<{ id: number; position: vec3; remaining: number }> = [];
  private _nextWorldMarkId = 0;
  private readonly worldNdcCache: Map<number, { ndcX: number; ndcY: number; inFrustum: boolean }> =
    new Map();

  // NDC cache — populated by updateNDC(), read by MarkerBillboardSystem
  private readonly ndcCache: Map<number, { ndcX: number; ndcY: number; inFrustum: boolean }> =
    new Map();

  // Reusable vec4s to avoid per-frame allocations in updateNDC
  private readonly _worldPos = vec4.create();
  private readonly _clipH = vec4.create(); // feet → NDC X
  private readonly _clipV = vec4.create(); // elevated point → NDC Y

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

  /**
   * Adds a world-space mark at a surface hit point.
   * Dashing into one resets the dash cooldown and removes the mark.
   */
  public addWorldMark(position: vec3, duration: number): void {
    this.worldMarks.push({
      id: this._nextWorldMarkId++,
      position: vec3.clone(position),
      remaining: duration,
    });
  }

  /**
   * Removes the closest world mark within `radius` of `position`.
   * Returns true if one was found and removed (signals dash cooldown reset).
   */
  public clearWorldMarkNear(position: vec3, radius: number): boolean {
    for (let i = 0; i < this.worldMarks.length; i++) {
      if (vec3.distance(this.worldMarks[i]!.position, position) <= radius) {
        this.worldNdcCache.delete(this.worldMarks[i]!.id);
        this.worldMarks.splice(i, 1);
        return true;
      }
    }
    return false;
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
    for (let i = this.worldMarks.length - 1; i >= 0; i--) {
      const mark = this.worldMarks[i]!;
      if (mark.remaining === Infinity) continue;
      mark.remaining -= deltaTime;
      if (mark.remaining <= 0) {
        this.worldNdcCache.delete(mark.id);
        this.worldMarks.splice(i, 1);
      }
    }
  }

  /** Returns remaining time for a mark, or 0 if not marked. */
  public getRemainingTime(entityId: number): number {
    return this.marks.get(entityId) ?? 0;
  }

  /** Total active marks (enemy + world). Used by billboard early-out. */
  public getMarkedCount(): number {
    return this.marks.size + this.worldMarks.length;
  }

  /**
   * Projects all marked enemies to NDC using the same pattern as GrappleSystem.
   * Call once per frame after update(). Results readable via getNdc().
   *
   * Uses feet for NDC X (no perspective skew) and an elevated point for NDC Y
   * (correct 3D height above the enemy's head).
   */
  public updateNDC(camera: CameraComponent | null): void {
    if (!camera) {
      this.ndcCache.clear();
      return;
    }

    const cam = camera.getCamera();
    const vp = cam.getUnjitteredViewProjection();
    const entities = Engine.getEntities();

    // Remove stale entries for marks that expired this frame
    for (const id of this.ndcCache.keys()) {
      if (!this.marks.has(id)) this.ndcCache.delete(id);
    }

    for (const entityId of this.marks.keys()) {
      const entity = entities.getEntityById(entityId);
      const transform = entity?.getComponent('transform') as TransformComponent | null;
      if (!transform) {
        this.ndcCache.set(entityId, { ndcX: 0, ndcY: 0, inFrustum: false });
        continue;
      }

      const pos = transform.getTransform().getWorldPosition();

      // Feet → NDC X (horizontal tracking without perspective skew)
      vec4.set(this._worldPos, pos[0], pos[1], pos[2], 1.0);
      vec4.transformMat4(this._clipH, this._worldPos, vp);
      if (this._clipH[3] <= 0.01) {
        this.ndcCache.set(entityId, { ndcX: 0, ndcY: 0, inFrustum: false });
        continue;
      }
      const ndcX = this._clipH[0] / this._clipH[3];

      // Elevated point → NDC Y (correct 3D height above enemy head)
      vec4.set(this._worldPos, pos[0], pos[1] + MARK_Y_OFFSET, pos[2], 1.0);
      vec4.transformMat4(this._clipV, this._worldPos, vp);
      if (this._clipV[3] <= 0.01) {
        this.ndcCache.set(entityId, { ndcX: 0, ndcY: 0, inFrustum: false });
        continue;
      }
      const ndcY = this._clipV[1] / this._clipV[3];

      this.ndcCache.set(entityId, {
        ndcX,
        ndcY,
        inFrustum: Math.abs(ndcX) <= 1.1 && Math.abs(ndcY) <= 1.1,
      });
    }

    // World marks: project surface hit point + small Y bump
    for (const id of this.worldNdcCache.keys()) {
      if (!this.worldMarks.some((m) => m.id === id)) this.worldNdcCache.delete(id);
    }
    for (const mark of this.worldMarks) {
      vec4.set(
        this._worldPos,
        mark.position[0],
        mark.position[1] + WORLD_MARK_Y_OFFSET,
        mark.position[2],
        1.0,
      );
      vec4.transformMat4(this._clipH, this._worldPos, vp);
      if (this._clipH[3] <= 0.01) {
        this.worldNdcCache.set(mark.id, { ndcX: 0, ndcY: 0, inFrustum: false });
        continue;
      }
      const wX = this._clipH[0] / this._clipH[3];
      const wY = this._clipH[1] / this._clipH[3];
      this.worldNdcCache.set(mark.id, {
        ndcX: wX,
        ndcY: wY,
        inFrustum: Math.abs(wX) <= 1.1 && Math.abs(wY) <= 1.1,
      });
    }
  }

  /** Returns precomputed NDC for a world mark by its id, or null if not cached. */
  public getWorldMarkNdc(id: number): { ndcX: number; ndcY: number; inFrustum: boolean } | null {
    return this.worldNdcCache.get(id) ?? null;
  }

  /** Returns the precomputed screen NDC for a marked enemy, or null if not cached. */
  public getNdc(entityId: number): { ndcX: number; ndcY: number; inFrustum: boolean } | null {
    return this.ndcCache.get(entityId) ?? null;
  }

  /**
   * Iterate over all currently active marks.
   * Callback receives the entityId and remaining duration in seconds.
   */
  public forEach(callback: (entityId: number, remaining: number) => void): void {
    for (const [id, remaining] of this.marks) {
      callback(id, remaining);
    }
  }

  /** Iterate over world-space marks. Callback receives id and remaining duration. */
  public forEachWorldMark(callback: (id: number, remaining: number) => void): void {
    for (const mark of this.worldMarks) {
      callback(mark.id, mark.remaining);
    }
  }
}
