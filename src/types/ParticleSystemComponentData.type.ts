export interface ParticleSystemComponentData {
  maxParticles?: number; // Número máximo de partículas
  emissionRate?: number; // Partículas por segundo
  particleLife?: number; // Vida base en segundos
  particleLifeVarianceMin?: number; // Varianza mínima de vida (se suma a particleLife de forma aleatoria)
  particleLifeVarianceMax?: number; // Varianza máxima de vida (se suma a particleLife de forma aleatoria)
  spawnRadius?: number | number[]; // Half-extents del box de spawn: number (cubo uniforme) o [x,y,z]
  startColor?: number[]; // Color inicial [r,g,b,a]
  endColor?: number[]; // Color final [r,g,b,a]
  startSize?: number; // Tamaño inicial
  endSize?: number; // Tamaño final
  baseVelocity?: number[]; // Velocidad base [x,y,z] (se combina con dirección aleatoria según randomness)
  velocitySpread?: number; // Dispersión aleatoria de la velocidad respecto a baseVelocity (0-1)
  gravity?: number[]; // Fuerza de gravedad acumulada en velocidad [x,y,z]
  worldSpace?: boolean; // Si true, las partículas se emiten en world space y no siguen al emisor
  material?: string; // Material a usar (opcional, por defecto según worldSpace)
  mesh?: string; // Mesh a usar (opcional, por defecto quad.obj)
  /** Si true, emite `burstCount` partículas en el primer update y detiene la emisión continua. */
  oneShot?: boolean;
  /** Partículas a emitir en modo oneShot (por defecto: maxParticles). */
  burstCount?: number;
  /** Si false, el emisor no emite continuamente al inicio — usar burst() para activar. Por defecto true. */
  emitting?: boolean;
}
