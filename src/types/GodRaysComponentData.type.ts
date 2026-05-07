export type GodRaysComponentData = Readonly<{
  enabled?: boolean;
  /** Scattering coefficient σs — in-scatter strength (default 0.3) */
  density?: number;
  /** Extinction coefficient σt = σs + σa — opacity per world unit (default 0.35) */
  extinction?: number;
  /** Number of raymarch steps — more = less banding, more GPU cost (default 32) */
  numSteps?: number;
  /** Linear brightness multiplier on the accumulated volumetric light (default 1.0) */
  intensity?: number;
  /** Additional scale applied in the composite pass (default 1.0) */
  compositeScale?: number;
}>;
