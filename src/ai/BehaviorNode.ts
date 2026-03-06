import { Blackboard } from './Blackboard';

/**
 * The three states every BT node can return on a tick.
 *
 *  SUCCESS — node completed successfully
 *  FAILURE — node completed but failed
 *  RUNNING — node is mid-execution; will be revisited next tick
 */
export const enum Status {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  RUNNING = 'RUNNING',
}

/**
 * Abstract base for every node in the behavior tree.
 *
 * Rules:
 *  - `tick()` must be synchronous and deterministic.
 *  - `reset()` must recursively restore the node (and its children) to their
 *    initial state so the tree can be restarted cleanly.
 *  - Nodes must NOT hold references to GPU resources or scene state —
 *    all shared data lives in the Blackboard.
 */
export abstract class BehaviorNode {
  /** Human-readable label, only used for debug output. */
  public readonly label: string;

  constructor(label = '') {
    this.label = label;
  }

  /**
   * Evaluates this node for one game-loop tick.
   * @param bb - The agent's blackboard (read/write shared data).
   */
  public abstract tick(bb: Blackboard): Status;

  /**
   * Resets the node back to its initial state.
   * Composite nodes must also reset all children.
   */
  public abstract reset(): void;
}
