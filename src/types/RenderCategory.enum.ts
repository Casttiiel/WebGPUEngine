export enum RenderCategory {
  SOLIDS = 'solids',
  TRANSPARENT = 'transparent',
  /** Lit, fogged particles: drawn after the volumetric fog, which they apply at their own depth. */
  PARTICLES = 'particles',
  GLASS = 'glass',
  DISTORSIONS = 'distorsions',
  DECALS = 'decals',
  SHADOWS = 'shadows',
  WATER = 'water',
  VIEW_MODEL = 'view_model',
}
