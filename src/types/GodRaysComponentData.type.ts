export type GodRaysComponentData = Readonly<{
  enabled?: boolean;
  /** Luminance threshold: pixels brighter than this are treated as sky/sun (default 0.8) */
  occlusionThreshold?: number;
  /** Rays intensity multiplier (default 1.0) */
  intensity?: number;
  /** Ray sampling density — controls step spacing along the march (default 0.96) */
  density?: number;
  /** Light decay per step: < 1 fades rays with distance (default 0.97) */
  decay?: number;
  /** Final weight applied to accumulated rays (default 0.4) */
  weight?: number;
}>;
