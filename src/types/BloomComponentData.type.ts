export type BloomComponentData = Readonly<{
  /** Bright-pass lower threshold. Default: 12.0 */
  thresholdMin?: number;
  /** Bright-pass upper threshold. Default: 0.7 */
  thresholdMax?: number;
  /** Emissive boost fed into the bright-pass. Default: 2.0 */
  emissiveFactor?: number;
  /** Bloom weight added onto the scene. Default: 1.0 */
  intensity?: number;
  /** Lens dirt strength. 0 = off. Depends on how dark the texture is (lens_dirt.jpg: ~30–60). Default: 0 */
  lensDirtIntensity?: number;
  /** Lens dirt texture path (black = clean lens). Default: lens_dirt.jpg */
  lensDirtTexture?: string;
}>;
