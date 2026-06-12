import { vec3 } from 'gl-matrix';

export type NoiseType = 'footstep' | 'attack' | 'landing' | 'impact' | 'door';

export interface NoiseEvent {
  readonly position: vec3;
  /** How far the noise carries from its origin (metres). */
  readonly radius: number;
  readonly type: NoiseType;
  /** Wall-clock second when this event expires (performance.now() / 1000). */
  readonly expireAt: number;
}

/**
 * NoiseEventDispatcher
 *
 * Lightweight static bus for audio-based perception events.
 * Any game system emits noise here; PerceptionComponent polls it each check cycle.
 *
 * Audibility rule:
 *   distance(event.position, listener) <= listener.hearRadius + event.radius
 *
 * Usage — emit from player or world systems:
 *   NoiseEventDispatcher.emit(playerPos, 6, 'footstep');
 *   NoiseEventDispatcher.emit(doorPos, 10, 'door');
 *
 * Usage — query from PerceptionComponent:
 *   const events = NoiseEventDispatcher.getEventsInRange(enemyEyePos, hearRadius);
 */
export class NoiseEventDispatcher {
  private static readonly _events: NoiseEvent[] = [];

  /** Emit a noise at `position` that carries `radius` metres. Events expire after 0.5 s. */
  static emit(position: vec3, radius: number, type: NoiseType): void {
    NoiseEventDispatcher._events.push({
      position: vec3.clone(position),
      radius,
      type,
      expireAt: performance.now() / 1000 + 0.5,
    });
  }

  /**
   * Returns all non-expired events audible to a listener at `listenerPos`
   * with hearing radius `listenerHearRadius`.
   * Prunes expired events as a side effect.
   */
  static getEventsInRange(listenerPos: vec3, listenerHearRadius: number): NoiseEvent[] {
    const now = performance.now() / 1000;
    const events = NoiseEventDispatcher._events;

    // Compact expired events in-place
    let w = 0;
    for (let r = 0; r < events.length; r++) {
      const ev = events[r];
      if (ev && ev.expireAt > now) events[w++] = ev;
    }
    events.length = w;

    const result: NoiseEvent[] = [];
    for (const ev of events) {
      const dx = ev.position[0] - listenerPos[0];
      const dy = ev.position[1] - listenerPos[1];
      const dz = ev.position[2] - listenerPos[2];
      const maxDist = listenerHearRadius + ev.radius;
      if (dx * dx + dy * dy + dz * dz <= maxDist * maxDist) {
        result.push(ev);
      }
    }
    return result;
  }

  /** Remove all events — call on scene reset or level load. */
  static clear(): void {
    NoiseEventDispatcher._events.length = 0;
  }
}
