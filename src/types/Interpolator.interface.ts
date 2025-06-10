export interface Interpolator {
  blend(start: number, end: number, ratio: number): number;
}
