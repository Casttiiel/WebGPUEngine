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
  /**
   * Aspecto por partícula (solo world space). Cada partícula tiene su propio azar: ángulo
   * inicial, sentido y ritmo de giro, variante del atlas y fase del aleteo.
   */
  /** Giro en el plano de la pantalla (rad/s, máximo; cada partícula entre la mitad y esto). Default 0. */
  spinSpeed?: number;
  /** Volteo fingido en 3D (se achata en un eje como si girase sobre sí misma; rad/s). Default 0. */
  tumbleSpeed?: number;
  /** La textura es un atlas de [columnas, filas] variantes; cada partícula usa una al azar. Default [1, 1]. */
  atlas?: [number, number];
  /** Vaivén lateral al caer, como un papel (m de amplitud). Default 0. */
  flutter?: number;
  /** Se desvanece al acercarse a la cámara: transparente a la mitad de esta distancia (m). Default 0 (no). */
  nearFade?: number;
  /**
   * Solo técnicas LIT (particle_ash.tech): luz del sol que atraviesa el copo cuando se ve a
   * contraluz (0 = ninguna). Default 0.6.
   */
  translucency?: number;
}
