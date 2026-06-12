export type ChromaticAberrationComponentData = Readonly<{
  /** Overall aberration strength. 0 = off, 5 = extreme. Default: 0.5 */
  intensity?: number;
  /** Fraction of screen radius before CA kicks in (0 = full screen, 1 = edges only). Default: 0 */
  startOffset?: number;
}>;
