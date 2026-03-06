/**
 * Blackboard
 *
 * Shared data store for a single AI agent. The Behavior Tree reads and writes
 * values here; Perception, pathfinding, and any other systems write their
 * results here too, keeping the BT nodes themselves stateless.
 *
 * Design rules:
 *  - All access is synchronous — no Promises, no async.
 *  - Keys are plain strings; values are typed via generics at the call site.
 *  - Listeners are fired immediately on set() so reactive nodes can act in
 *    the same tick without waiting for the next step().
 */

type Listener<T> = (newValue: T, oldValue: T | undefined) => void;

export class Blackboard {
  private data: Map<string, unknown> = new Map();
  private listeners: Map<string, Set<Listener<unknown>>> = new Map();

  // ─── Read ──────────────────────────────────────────────────────────────────

  /** Returns the stored value, or `defaultValue` if the key is absent. */
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.data.get(key);
    if (value === undefined) return defaultValue;
    return value as T;
  }

  /** Returns true when the key exists (even if its value is `null`). */
  public has(key: string): boolean {
    return this.data.has(key);
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /** Stores a value and fires any registered listeners if the value changed. */
  public set<T>(key: string, value: T): void {
    const old = this.data.get(key) as T | undefined;

    // Skip store + listeners if nothing actually changed (shallow equality).
    if (old === value) return;

    this.data.set(key, value);

    const keyListeners = this.listeners.get(key);
    if (keyListeners) {
      for (const listener of keyListeners) {
        (listener as Listener<T>)(value, old);
      }
    }
  }

  /** Removes a key. Listeners registered for this key are NOT removed. */
  public delete(key: string): void {
    this.data.delete(key);
  }

  /** Removes all keys. Listeners are preserved. */
  public clear(): void {
    this.data.clear();
  }

  // ─── Listeners ─────────────────────────────────────────────────────────────

  /**
   * Registers a callback that fires whenever `key` is set to a new value.
   * Returns an unsubscribe function for easy cleanup.
   *
   * @example
   * const unsub = bb.onChange('canSeePlayer', (val) => { ... });
   * // later:
   * unsub();
   */
  public onChange<T>(key: string, listener: Listener<T>): () => void {
    let keyListeners = this.listeners.get(key);
    if (!keyListeners) {
      keyListeners = new Set();
      this.listeners.set(key, keyListeners);
    }
    keyListeners.add(listener as Listener<unknown>);

    return () => {
      keyListeners!.delete(listener as Listener<unknown>);
    };
  }

  /** Removes all listeners for a key. */
  public removeListeners(key: string): void {
    this.listeners.delete(key);
  }

  // ─── Debug ─────────────────────────────────────────────────────────────────

  /** Returns a plain object snapshot of the current state — useful for debug UI. */
  public snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.data) {
      out[k] = v;
    }
    return out;
  }

  /** Pretty-prints the current state to the console. */
  public dump(label = 'Blackboard'): void {
    console.group(label);
    for (const [k, v] of this.data) {
      console.log(`  ${k}:`, v);
    }
    console.groupEnd();
  }
}
