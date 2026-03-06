import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Inverter (decorator)
 *
 * Flips SUCCESS ↔ FAILURE of its child. RUNNING passes through unchanged.
 *
 * @example
 * // Succeed only when the player is NOT visible
 * new Inverter(new Condition('CanSeePlayer', bb => bb.get('canSeePlayer', false)))
 */
export class Inverter extends BehaviorNode {
  private readonly child: BehaviorNode;

  constructor(child: BehaviorNode, label = 'Inverter') {
    super(label);
    this.child = child;
  }

  public tick(bb: Blackboard): Status {
    const status = this.child.tick(bb);
    if (status === Status.SUCCESS) return Status.FAILURE;
    if (status === Status.FAILURE) return Status.SUCCESS;
    return Status.RUNNING;
  }

  public reset(): void {
    this.child.reset();
  }
}

/**
 * AlwaysSucceed (decorator)
 *
 * Returns SUCCESS regardless of the child's result.
 * Useful to prevent a failing optional branch from blocking a Sequence.
 */
export class AlwaysSucceed extends BehaviorNode {
  private readonly child: BehaviorNode;

  constructor(child: BehaviorNode, label = 'AlwaysSucceed') {
    super(label);
    this.child = child;
  }

  public tick(bb: Blackboard): Status {
    const status = this.child.tick(bb);
    return status === Status.RUNNING ? Status.RUNNING : Status.SUCCESS;
  }

  public reset(): void {
    this.child.reset();
  }
}

/**
 * Repeat (decorator)
 *
 * Re-runs its child until it returns FAILURE, or until `maxIterations`
 * is reached (if specified). Always returns RUNNING while repeating.
 * Resets the child between iterations automatically.
 *
 * @example
 * // Loop patrol forever
 * new Repeat(patrolSequence)
 *
 * // Attempt an action up to 3 times before giving up
 * new Repeat(attackAction, { maxIterations: 3 })
 */
export class Repeat extends BehaviorNode {
  private readonly child: BehaviorNode;
  private readonly maxIterations: number;
  private iterations = 0;

  constructor(child: BehaviorNode, options: { maxIterations?: number; label?: string } = {}) {
    super(options.label ?? 'Repeat');
    this.child = child;
    this.maxIterations = options.maxIterations ?? Infinity;
  }

  public tick(bb: Blackboard): Status {
    const status = this.child.tick(bb);

    if (status === Status.RUNNING) return Status.RUNNING;

    if (status === Status.FAILURE) {
      this.iterations = 0;
      return Status.FAILURE;
    }

    // SUCCESS — increment and decide whether to loop or finish
    this.iterations++;
    this.child.reset();

    if (this.iterations >= this.maxIterations) {
      this.iterations = 0;
      return Status.SUCCESS;
    }

    return Status.RUNNING; // loop again next tick
  }

  public reset(): void {
    this.iterations = 0;
    this.child.reset();
  }
}
