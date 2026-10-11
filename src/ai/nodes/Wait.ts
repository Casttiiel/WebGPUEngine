import { Blackboard } from '../Blackboard';
import { BehaviorNode, Status } from '../BehaviorNode';

/**
 * Wait — devuelve RUNNING durante `seconds` segundos y luego SUCCESS.
 *
 * El tiempo avanza con el valor `dt` del blackboard (lo escribe el dueño del árbol antes
 * de cada step()), así respeta pausa, step y escala de tiempo.
 *
 * @example
 * new Sequence([new Wait('think', 0.5), attackAction])
 */
export class Wait extends BehaviorNode {
  private readonly seconds: number | ((bb: Blackboard) => number);
  private elapsed = 0;
  private started = false;
  private duration = 0;

  constructor(label: string, seconds: number | ((bb: Blackboard) => number)) {
    super(label);
    this.seconds = seconds;
  }

  public tick(bb: Blackboard): Status {
    if (!this.started) {
      this.started = true;
      this.elapsed = 0;
      this.duration = typeof this.seconds === 'function' ? this.seconds(bb) : this.seconds;
    } else {
      this.elapsed += bb.get<number>('dt', 0);
    }
    if (this.elapsed < this.duration) return Status.RUNNING;
    this.started = false;
    return Status.SUCCESS;
  }

  public reset(): void {
    this.started = false;
    this.elapsed = 0;
  }
}
