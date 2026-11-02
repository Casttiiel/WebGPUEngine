/**
 * Datos del componente `particle_system`, organizados en módulos (como los de un emisor de
 * Niagara): emitter → spawn → init → forces → overLife → render → lights. Todo es opcional;
 * lo que falta sale de los defaults de ParticleConfig. Las claves planas antiguas
 * (LegacyParticleData) se siguen aceptando y se traducen a módulos.
 */

export type ParticleSpawnShape = 'box' | 'sphere' | 'hemisphere' | 'cone' | 'cylinder' | 'disc' | 'point';
/** camera: mira a la cámara; velocity: se orienta (y estira) según su movimiento; horizontal:
 *  tumbado en el suelo; axis: gira alrededor de un eje fijo mirando a la cámara. */
export type ParticleFacing = 'camera' | 'velocity' | 'horizontal' | 'axis';
/** random: una variante del atlas al azar; life: avanza con la vida; loop: en bucle a `fps`. */
export type ParticleFlipbookMode = 'random' | 'life' | 'loop';
export type ParticleRendererType = 'sprite' | 'ribbon';

/** Clave de la curva de color: t ∈ [0, 1] de la vida, color [r, g, b, a] (rgb puede pasar de 1). */
export interface ParticleColorKey {
  t: number;
  color: number[];
}

/** Clave de una curva escalar: t ∈ [0, 1] de la vida. */
export interface ParticleScalarKey {
  t: number;
  value: number;
}

export interface ParticleEmitterModule {
  /** Partículas por segundo (emisión continua). */
  rate?: number;
  /** false: no emite al empezar (usar burst() / startEmitting()). Default true. */
  emitting?: boolean;
  /** Emite `burstCount` partículas en el primer update y no emite de forma continua. */
  oneShot?: boolean;
  /** Partículas del oneShot (default: maxParticles). */
  burstCount?: number;
}

export interface ParticleSpawnModule {
  shape?: ParticleSpawnShape;
  /** box: half-extents [x, y, z]; cylinder: y = media altura; cone: y = largo. */
  size?: number | number[];
  /** sphere / hemisphere / cylinder / disc / base del cono (m). */
  radius?: number;
  /** Hueco interior, fracción del radio (0 = volumen lleno, 1 = solo la superficie / el borde → anillo). */
  innerRadius?: number;
  /** cone: medio ángulo de apertura (grados). */
  angle?: number;
  /** Velocidad hacia fuera de la forma, según su normal (m/s): explosiones, chorros en cono. */
  radialSpeed?: number;
}

export interface ParticleInitModule {
  /** Vida base (s). */
  life?: number;
  /** Se suma a la vida un valor al azar en [min, max]. */
  lifeVariance?: [number, number];
  /** Velocidad base [x, y, z] (mundo). */
  velocity?: number[];
  /** Dispersión aleatoria de la velocidad por eje (m/s). */
  velocitySpread?: number;
  /** Cada partícula sale entre (1 - speedVariance) y 1 veces su velocidad. */
  speedVariance?: number;
  /** Tamaño de cada partícula entre (1 - v) y (1 + v) veces, la mayoría pequeñas. */
  sizeVariance?: number;
}

export interface ParticleCurlNoiseModule {
  enabled?: boolean;
  /** Aceleración del flujo (m/s²). */
  strength?: number;
  /** Tamaño de los remolinos: frecuencia espacial (1/m). */
  frequency?: number;
  /** Lo rápido que cambia el flujo con el tiempo. */
  speed?: number;
}

export interface ParticleVortexModule {
  enabled?: boolean;
  /** Velocidad de giro alrededor del eje (rad/s; negativo = al revés). */
  strength?: number;
  /** Aceleración hacia el eje (m/s²). */
  pull?: number;
  /** Eje en el espacio del emisor. */
  axis?: number[];
}

export interface ParticleAttractorModule {
  enabled?: boolean;
  /** Aceleración hacia el punto (m/s²; negativo = repele). */
  strength?: number;
  /** Punto, relativo al emisor (espacio del emisor). */
  position?: number[];
  /** Alcance (m): la fuerza cae a 0 en el borde. 0 = sin límite. */
  radius?: number;
}

export interface ParticleForcesModule {
  gravity?: number[];
  /** Frenado del aire: v *= exp(-drag·dt). */
  drag?: number;
  curlNoise?: ParticleCurlNoiseModule;
  vortex?: ParticleVortexModule;
  attractor?: ParticleAttractorModule;
}

export interface ParticleOverLifeModule {
  /** Gradiente de color + alpha a lo largo de la vida. */
  color?: ParticleColorKey[];
  /** Tamaño (m) a lo largo de la vida. */
  size?: ParticleScalarKey[];
  /** Multiplica el color (HDR: brasas y chispas que brillan). Default 1. */
  brightness?: number;
}

export interface ParticleFlipbookModule {
  /** Atlas de [columnas, filas] frames. */
  grid?: [number, number];
  mode?: ParticleFlipbookMode;
  /** loop: frames por segundo. */
  fps?: number;
  /** Funde cada frame con el siguiente (animación suave con pocos frames). */
  blend?: boolean;
}

export interface ParticleRibbonModule {
  /** Puntos de historial por partícula (largo de la estela = segments × interval s). */
  segments?: number;
  /** Segundos entre puntos. */
  interval?: number;
  /** Ancho en la cola (× el de la cabeza). */
  widthTail?: number;
  /** Alpha en la cola (× el de la cabeza). */
  alphaTail?: number;
}

export interface ParticleRenderModule {
  renderer?: ParticleRendererType;
  facing?: ParticleFacing;
  /** facing 'axis': eje [x, y, z] (espacio del emisor si las partículas son locales). */
  axis?: number[];
  /** Se alarga en su dirección de movimiento lo que recorre en estos segundos. */
  stretch?: number;
  /** Giro en el plano del sprite (rad/s máx.; cada partícula entre la mitad y esto). */
  spinSpeed?: number;
  /** Volteo fingido en 3D (rad/s). */
  tumbleSpeed?: number;
  /** Vaivén lateral al caer (m). */
  flutter?: number;
  /** Se desvanece al acercarse a la cámara: transparente a la mitad de esta distancia (m). */
  nearFade?: number;
  /** Soft particles: se funden con la escena en esta distancia (m). 0 = corte duro. */
  softDistance?: number;
  /** Solo técnicas LIT: luz del sol que atraviesa la partícula a contraluz. */
  translucency?: number;
  /** Solo particle_blood.tech: gota o neblina. */
  shape?: 'drop' | 'mist';
  flipbook?: ParticleFlipbookModule;
  ribbon?: ParticleRibbonModule;
}

/** Light renderer: las partículas escogidas (las más grandes) iluminan la escena (tiled). */
export interface ParticleLightsModule {
  enabled?: boolean;
  /** Fracción de partículas con luz (0..1): las de mayor tamaño. */
  fraction?: number;
  /** Tope de luces de este emisor por frame. */
  max?: number;
  radius?: number;
  intensity?: number;
  /** Color de la luz (× el de la partícula si useParticleColor). */
  color?: number[];
  /** Tiñe la luz con el color de la curva de vida (y su alpha la apaga). Default true. */
  useParticleColor?: boolean;
}

/** Claves planas del formato anterior (siguen funcionando). */
export interface LegacyParticleData {
  emissionRate?: number;
  particleLife?: number;
  particleLifeVarianceMin?: number;
  particleLifeVarianceMax?: number;
  spawnRadius?: number | number[];
  startColor?: number[];
  endColor?: number[];
  startSize?: number;
  endSize?: number;
  baseVelocity?: number[];
  velocitySpread?: number;
  gravity?: number[];
  oneShot?: boolean;
  burstCount?: number;
  emitting?: boolean;
  spinSpeed?: number;
  tumbleSpeed?: number;
  atlas?: [number, number];
  flutter?: number;
  nearFade?: number;
  translucency?: number;
  drag?: number;
  speedVariance?: number;
  sizeVariance?: number;
  stretch?: number;
  shape?: 'drop' | 'mist';
}

export interface ParticleSystemComponentData extends LegacyParticleData {
  maxParticles?: number;
  /** true: las partículas viven en el mundo (no siguen al emisor). */
  worldSpace?: boolean;
  /** Material (técnica: aditivo, alpha, LIT, sangre…). Default particle_worldspace.mat. */
  material?: string;
  emitter?: ParticleEmitterModule;
  spawn?: ParticleSpawnModule;
  init?: ParticleInitModule;
  forces?: ParticleForcesModule;
  overLife?: ParticleOverLifeModule;
  render?: ParticleRenderModule;
  lights?: ParticleLightsModule;
}
