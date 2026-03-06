import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Selector ("OR" / priority node)
 *
 * Ticks children left-to-right:
 *  - Returns SUCCESS immediately when a child succeeds.
 *  - Returns RUNNING if the current child is still running (resumes there
 *    next tick — "memory" behaviour).
 *  - Returns FAILURE only once every child has failed.
 *
 * Use `reactive: true` to re-evaluate from the first child every tick.
 * This is the standard way to implement priority-based interruption:
 * the leftmost (highest-priority) branch can preempt any running branch.
 *
 * @example
 * // Attack if possible, otherwise patrol, otherwise idle
 * new Selector([
 *   attackSequence,
 *   patrolSequence,
 *   new Action('Idle', () => Status.RUNNING),
 * ], { reactive: true })
 */
export class Selector extends BehaviorNode {
  private readonly children: BehaviorNode[];
  private readonly reactive: boolean;
  private runningIndex = 0;

  constructor(children: BehaviorNode[], options: { label?: string; reactive?: boolean } = {}) {
    super(options.label ?? 'Selector');
    this.children = children;
    this.reactive = options.reactive ?? false;
  }

  public tick(bb: Blackboard): Status {
    const start = this.reactive ? 0 : this.runningIndex;

    for (let i = start; i < this.children.length; i++) {
      const status = this.children[i]!.tick(bb);

      if (status === Status.RUNNING) {
        this.runningIndex = i;
        return Status.RUNNING;
      }

      if (status === Status.SUCCESS) {
        this.runningIndex = 0;
        return Status.SUCCESS;
      }

      // Status.FAILURE → try next child
    }

    this.runningIndex = 0;
    return Status.FAILURE;
  }

  public reset(): void {
    this.runningIndex = 0;
    for (const child of this.children) child.reset();
  }
}
