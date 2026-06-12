export type FilmGrainComponentData = Readonly<{
  /** Grain visibility. 0 = off, 1 = strong. Default: 0.3 */
  intensity?: number;
  /** Size of individual grain particles in pixels. 1 = fine, 4 = coarse. Default: 1.6 */
  grainSize?: number;
  /** Whether the grain is animated each frame. Default: true */
  animated?: boolean;
  /** Whether to use RGB noise instead of monochrome. Default: false */
  colorized?: boolean;
}>;
