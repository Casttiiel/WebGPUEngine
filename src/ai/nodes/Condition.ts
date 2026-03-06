import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Condition (leaf node)
 *
 * Evaluates a predicate synchronously and maps the boolean result to
 * SUCCESS / FAILURE. Never returns RUNNING.
 *
 * Conditions should be pure reads of the Blackboard (or cheap derived
 * computations) — they should not produce side-effects.
 *
 * @example
 * new Condition('CanSeePlayer', bb => bb.get('canSeePlayer', false))
 * new Condition('LowHealth',    bb => bb.get('health', 100) < 25)
 * new Condition('CloseEnough',  bb => bb.get('distToPlayer', Infinity) < 3)
 */
export class Condition extends BehaviorNode {
  private readonly predicate: (bb: Blackboard) => boolean;

  constructor(label: string, predicate: (bb: Blackboard) => boolean) {
    super(label);
    this.predicate = predicate;
  }

  public tick(bb: Blackboard): Status {
    return this.predicate(bb) ? Status.SUCCESS : Status.FAILURE;
  }

  public reset(): void {}
}
