export type GodRaysComponentData = Readonly<{
  enabled?: boolean;
  /** Scattering coefficient σs per world unit — in-scatter strength (default 0.02) */
  density?: number;
  /** Extinction coefficient σt per world unit — fog transmittance along the view ray (default 0.01) */
  extinction?: number;
  /** Henyey-Greenstein anisotropy g — 0 isotropic, >0 glows toward the sun (default 0.4) */
  anisotropy?: number;
  /** Target raymarch step length in world units (default 1.0) */
  stepSize?: number;
  /** Upper bound on raymarch steps per pixel (default 64) */
  numSteps?: number;
  /** Max march distance from the camera in world units; also capped by the CSM range (default 80) */
  maxDistance?: number;
  /** Relative depth tolerance of the bilateral blur (default 0.05) */
  blurDepthSigma?: number;
  /** Linear brightness multiplier on the accumulated volumetric light (default 1.0) */
  intensity?: number;
  /** Additional scale applied in the composite pass (default 1.0) */
  compositeScale?: number;
}>;
