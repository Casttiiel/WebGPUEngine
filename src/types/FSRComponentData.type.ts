export type FSRComponentData = Readonly<{
  /**
   * Internal render scale as a fraction of canvas resolution.
   * 0.5 = half resolution (big perf gain, FSR upscales to full).
   * 0.75 = Quality mode equivalent.
   * 1.0 = native resolution (EASU skipped, only RCAS runs if enabled).
   * Range: [0.25, 1.0]. Defaults to 1.0 if omitted.
   */
  renderScale?: number;
  /** Enable EASU + RCAS passes. Defaults to true. */
  enabled?: boolean;
  /** Enable the RCAS sharpening pass after EASU. Defaults to true. */
  enableRCAS?: boolean;
  /**
   * RCAS sharpness: 0 = maximum sharpening, 2 = very gentle.
   * Defaults to 0.2.
   */
  rcasSharpness?: number;
}>;
