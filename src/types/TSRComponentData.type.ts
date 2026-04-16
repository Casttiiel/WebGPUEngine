export type TSRComponentData = Readonly<{
  /**
   * Internal render scale as a fraction of canvas resolution.
   * 0.5  = half resolution (big perf saving, TSR temporally upscales to full).
   * 0.75 = quality mode (equivalent to FSR Quality).
   * 1.0  = native resolution (TSR acts as pure TAA, no spatial upscaling).
   * Range: [0.25, 1.0]. Defaults to 1.0 if omitted.
   */
  renderScale?: number;
  /** Base blend weight toward the current frame. Default: 0.1 (90% history). */
  blendFactor?: number;
  /** Unsharp-mask sharpening strength after the temporal blend. Default: 0. */
  sharpenStrength?: number;
  /** Variance-clamp std-dev multiplier for the neighbourhood AABB. Default: 1.25. */
  gamma?: number;
}>;
