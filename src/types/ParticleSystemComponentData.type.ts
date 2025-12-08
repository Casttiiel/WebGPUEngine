export interface ParticleSystemComponentData {
  maxParticles?: number; // Número máximo de partículas
  emissionRate?: number; // Partículas por segundo
  particleLife?: number; // Vida en segundos
  spawnRadius?: number; // Radio de spawn de las partículas
  startColor?: number[]; // Color inicial [r,g,b,a]
  endColor?: number[]; // Color final [r,g,b,a]
  startSize?: number; // Tamaño inicial
  endSize?: number; // Tamaño final
  velocity?: number[]; // Velocidad base [x,y,z]
  randomness?: number; // Factor de aleatoriedad (0-1)
  gravity?: number[]; // Fuerza de gravedad [x,y,z]
  worldSpace?: boolean; // Si true, las partículas se emiten en world space y no siguen al emisor
}
