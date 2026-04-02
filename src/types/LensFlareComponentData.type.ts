export type LensFlareComponentData = Readonly<{
  /** Enable / disable the lens flare effect (default true) */
  enabled?: boolean;
  /** Overall flare intensity multiplier (default 1.0) */
  intensity?: number;
  /** Ghost element size scale factor — larger values produce bigger flare discs (default 1.0) */
  ghostScale?: number;
}>;
