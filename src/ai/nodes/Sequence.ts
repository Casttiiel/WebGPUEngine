import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Sequence ("AND" node)
 *
 * Ticks children left-to-right:
 *  - Returns FAILURE immediately when a child fails.
 *  - Returns RUNNING if the current child is still running (resumes there
 *    next tick — "memory" behaviour).
 *  - Returns SUCCESS only once every child has succeeded.
 *
 * Use `reactive: true` to re-evaluate from the first child every tick
 * (useful when higher-priority conditions might cancel the sequence).
 *
 * @example
 * // Attack only when close AND weapon is ready
 * new Sequence([
 *   new Condition('Close enough', bb => bb.get('distToPlayer', Infinity) < 2),
 *   new Condition('Weapon ready',  bb => bb.get('weaponCooldown', 0) <= 0),
 *   new Action('Attack', bb => { ... return Status.SUCCESS; }),
 * ])
 */
export class Sequence extends BehaviorNode {
  private readonly children: BehaviorNode[];
  private readonly reactive: boolean;
  private runningIndex = 0;

  constructor(children: BehaviorNode[], options: { label?: string; reactive?: boolean } = {}) {
    super(options.label ?? 'Sequence');
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

      if (status === Status.FAILURE) {
        this.runningIndex = 0;
        return Status.FAILURE;
      }

      // Status.SUCCESS → continue to next child
    }

    this.runningIndex = 0;
    return Status.SUCCESS;
  }

  public reset(): void {
    this.runningIndex = 0;
    for (const child of this.children) child.reset();
  }
}
