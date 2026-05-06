export const enum GrappleTargetType {
  /** Surface with floor above — player travels to the top and mantles. */
  LEDGE,
  /** Vertical edge / wall — player redirects conserving momentum. */
  CORNER,
  /** Ring or beam with no surface above — pure impulse, player keeps flying. */
  RING,
  /** Explicit grapple hook target point — pure impulse, no surface snap. */
  PUNCTUAL,
}
