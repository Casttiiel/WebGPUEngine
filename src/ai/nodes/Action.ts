import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Action (leaf node)
 *
 * Wraps any game-side function that reads/writes the Blackboard and returns
 * a Status. This is where actual behaviour lives — moving, attacking,
 * playing animations, etc.
 *
 * The function receives the Blackboard and is expected to:
 *  - Return SUCCESS when the action completes successfully.
 *  - Return FAILURE when the action cannot be completed.
 *  - Return RUNNING when the action is in progress (will be called again
 *    next tick by the parent composite).
 *
 * @example
 * new Action('MoveToPlayer', (bb) => {
 *   const dist = bb.get<number>('distToPlayer', Infinity);
 *   if (dist < 0.5) return Status.SUCCESS;
 *   // move towards player ...
 *   return Status.RUNNING;
 * })
 */
export class Action extends BehaviorNode {
  private readonly fn: (bb: Blackboard) => Status;

  constructor(label: string, fn: (bb: Blackboard) => Status) {
    super(label);
    this.fn = fn;
  }

  public tick(bb: Blackboard): Status {
    return this.fn(bb);
  }

  /** Actions are stateless from the tree's perspective — nothing to reset. */
  public reset(): void {}
}
