import { Blackboard } from './Blackboard';
import { BehaviorNode, Status } from './BehaviorNode';

/**
 * BehaviorTree
 *
 * Owns a root node and drives it each game-loop tick via `step()`.
 * One instance per agent — each agent has its own tree + blackboard.
 *
 * @example
 * const bb   = new Blackboard();
 * const root = new Selector([ attackSequence, patrolSequence, idleAction ]);
 * const tree = new BehaviorTree(root, bb);
 *
 * // In EnemyControllerComponent.update(dt):
 * tree.step();
 */
export class BehaviorTree {
  private readonly root: BehaviorNode;
  private readonly bb: Blackboard;

  /** Last status returned by the root node. */
  public lastStatus: Status = Status.RUNNING;

  constructor(root: BehaviorNode, blackboard: Blackboard) {
    this.root = root;
    this.bb = blackboard;
  }

  /**
   * Advances the tree by one tick.
   * Call this once per game-loop frame from the owning component's `update()`.
   */
  public step(): Status {
    this.lastStatus = this.root.tick(this.bb);
    return this.lastStatus;
  }

  /**
   * Resets the entire tree to its initial state.
   * Useful when the agent changes behaviour mode (e.g. enters combat from patrol).
   */
  public reset(): void {
    this.root.reset();
    this.lastStatus = Status.RUNNING;
  }

  public getBlackboard(): Blackboard {
    return this.bb;
  }

  public isRunning(): boolean {
    return this.lastStatus === Status.RUNNING;
  }
}
