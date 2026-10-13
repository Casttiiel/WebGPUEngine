export type TSRComponentData = Readonly<{
  /**
   * Internal render scale as a fraction of canvas resolution.
   * 0.5  = half resolution (big perf saving, TSR temporally upscales to full).
   * 0.75 = quality mode (equivalent to FSR Quality).
   * 1.0  = native resolution (TSR acts as pure TAA, no spatial upscaling).
   * Range: [0.25, 1.0]. Defaults to the quality preset if omitted.
   */
  renderScale?: number;
  /** Minimum weight of the current frame. Default: 0.025 (three.js TAAU). */
  currentFrameWeight?: number;
  /** Relative linear-depth jump treated as disocclusion. Default: 0.01. */
  depthThreshold?: number;
  /** Relative depth range in the 3×3 that marks a geometric edge. Default: 0.05. */
  edgeDepthDiff?: number;
  /** Motion (px) at which the history is fully distrusted. Default: 128. */
  maxVelocityLength?: number;
}>;
