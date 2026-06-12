export type VignetteComponentData = Readonly<{
  /** Vignette darkness. 0 = off, 1 = fully dark corners. Default: 0.4 */
  intensity?: number;
  /** Edge gradient softness. 0 = sharp, 1 = very soft. Default: 0.5 */
  smoothness?: number;
}>;
