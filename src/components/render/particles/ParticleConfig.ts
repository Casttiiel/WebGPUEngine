import {
  ParticleColorKey,
  ParticleFacing,
  ParticleFlipbookMode,
  ParticleRendererType,
  ParticleScalarKey,
  ParticleSpawnShape,
  ParticleSystemComponentData,
} from '../../../types/ParticleSystemComponentData.type';

type Vec3 = [number, number, number];

/**
 * Configuración completa de un emisor: los módulos de ParticleSystemComponentData con todos
 * sus valores resueltos. Es lo que edita el F2 y lo que el componente sube a la GPU cada frame.
 */
export interface ParticleConfig {
  maxParticles: number;
  worldSpace: boolean;
  material: string;
  emitter: { rate: number; emitting: boolean; oneShot: boolean; burstCount: number };
  spawn: {
    shape: ParticleSpawnShape;
    size: Vec3;
    radius: number;
    innerRadius: number;
    angle: number;
    radialSpeed: number;
  };
  init: {
    life: number;
    lifeVariance: [number, number];
    velocity: Vec3;
    velocitySpread: number;
    speedVariance: number;
    sizeVariance: number;
  };
  forces: {
    gravity: Vec3;
    drag: number;
    curlNoise: { enabled: boolean; strength: number; frequency: number; speed: number };
    vortex: { enabled: boolean; strength: number; pull: number; axis: Vec3 };
    attractor: { enabled: boolean; strength: number; position: Vec3; radius: number };
  };
  overLife: { color: ParticleColorKey[]; size: ParticleScalarKey[]; brightness: number };
  render: {
    renderer: ParticleRendererType;
    facing: ParticleFacing;
    axis: Vec3;
    stretch: number;
    spinSpeed: number;
    tumbleSpeed: number;
    flutter: number;
    nearFade: number;
    softDistance: number;
    translucency: number;
    shape: 'drop' | 'mist';
    flipbook: { grid: [number, number]; mode: ParticleFlipbookMode; fps: number; blend: boolean };
    ribbon: { segments: number; interval: number; widthTail: number; alphaTail: number };
  };
  lights: {
    enabled: boolean;
    fraction: number;
    max: number;
    radius: number;
    intensity: number;
    color: Vec3;
    useParticleColor: boolean;
  };
}

export const SPAWN_SHAPES: ParticleSpawnShape[] = ['box', 'sphere', 'hemisphere', 'cone', 'cylinder', 'disc', 'point'];
export const FACINGS: ParticleFacing[] = ['camera', 'velocity', 'horizontal', 'axis'];
export const FLIPBOOK_MODES: ParticleFlipbookMode[] = ['random', 'life', 'loop'];
export const RENDERERS: ParticleRendererType[] = ['sprite', 'ribbon'];
/** Máximo de puntos de estela por partícula (el spawn rellena todos al nacer). */
export const MAX_RIBBON_SEGMENTS = 32;

function defaults(): ParticleConfig {
  return {
    maxParticles: 1024,
    worldSpace: false,
    material: 'particle_worldspace.mat',
    emitter: { rate: 100, emitting: true, oneShot: false, burstCount: 1024 },
    spawn: { shape: 'box', size: [2, 2, 2], radius: 1, innerRadius: 0, angle: 25, radialSpeed: 0 },
    init: {
      life: 3,
      lifeVariance: [0, 0],
      velocity: [0, 1, 0],
      velocitySpread: 0.5,
      speedVariance: 0,
      sizeVariance: 0,
    },
    forces: {
      gravity: [0, -9.81, 0],
      drag: 0,
      curlNoise: { enabled: false, strength: 2, frequency: 0.8, speed: 0.5 },
      vortex: { enabled: false, strength: 3, pull: 0, axis: [0, 1, 0] },
      attractor: { enabled: false, strength: 5, position: [0, 1, 0], radius: 0 },
    },
    overLife: {
      color: [
        { t: 0, color: [1, 1, 1, 1] },
        { t: 1, color: [1, 1, 1, 1] },
      ],
      size: [
        { t: 0, value: 0.1 },
        { t: 1, value: 0.1 },
      ],
      brightness: 1,
    },
    render: {
      renderer: 'sprite',
      facing: 'camera',
      axis: [0, 1, 0],
      stretch: 0,
      spinSpeed: 0,
      tumbleSpeed: 0,
      flutter: 0,
      nearFade: 0,
      softDistance: 0,
      translucency: 0.6,
      shape: 'drop',
      flipbook: { grid: [1, 1], mode: 'random', fps: 12, blend: false },
      ribbon: { segments: 12, interval: 0.02, widthTail: 0.2, alphaTail: 0 },
    },
    lights: {
      enabled: false,
      fraction: 0.05,
      max: 16,
      radius: 2,
      intensity: 2,
      color: [1, 1, 1],
      useParticleColor: true,
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mezcla `src` sobre `dst` campo a campo (los arrays se sustituyen enteros). */
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    const base = dst[key];
    if (isObject(base) && isObject(value)) deepMerge(base, value);
    else dst[key] = Array.isArray(value) ? structuredClone(value) : value;
  }
}

function vec3Of(v: number | number[]): Vec3 {
  return typeof v === 'number' ? [v, v, v] : [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
}

/** Claves planas del formato anterior → módulos. */
function fromLegacy(d: ParticleSystemComponentData): Record<string, unknown> {
  const m: Record<string, Record<string, unknown>> = {
    emitter: {},
    spawn: {},
    init: {},
    forces: {},
    overLife: {},
    render: {},
  };
  if (d.emissionRate !== undefined) m.emitter!.rate = d.emissionRate;
  if (d.emitting !== undefined) m.emitter!.emitting = d.emitting;
  if (d.oneShot !== undefined) m.emitter!.oneShot = d.oneShot;
  if (d.burstCount !== undefined) m.emitter!.burstCount = d.burstCount;
  if (d.spawnRadius !== undefined) m.spawn!.size = vec3Of(d.spawnRadius);
  if (d.particleLife !== undefined) m.init!.life = d.particleLife;
  if (d.particleLifeVarianceMin !== undefined || d.particleLifeVarianceMax !== undefined) {
    m.init!.lifeVariance = [d.particleLifeVarianceMin ?? 0, d.particleLifeVarianceMax ?? 0];
  }
  if (d.baseVelocity !== undefined) m.init!.velocity = vec3Of(d.baseVelocity);
  if (d.velocitySpread !== undefined) m.init!.velocitySpread = d.velocitySpread;
  if (d.speedVariance !== undefined) m.init!.speedVariance = d.speedVariance;
  if (d.sizeVariance !== undefined) m.init!.sizeVariance = d.sizeVariance;
  if (d.gravity !== undefined) m.forces!.gravity = vec3Of(d.gravity);
  if (d.drag !== undefined) m.forces!.drag = d.drag;
  if (d.startColor !== undefined || d.endColor !== undefined) {
    const start = d.startColor ?? [1, 1, 1, 1];
    m.overLife!.color = [
      { t: 0, color: [...start] },
      { t: 1, color: [...(d.endColor ?? start)] },
    ];
  }
  if (d.startSize !== undefined || d.endSize !== undefined) {
    const start = d.startSize ?? 0.1;
    m.overLife!.size = [
      { t: 0, value: start },
      { t: 1, value: d.endSize ?? start },
    ];
  }
  const r = m.render!;
  if (d.spinSpeed !== undefined) r.spinSpeed = d.spinSpeed;
  if (d.tumbleSpeed !== undefined) r.tumbleSpeed = d.tumbleSpeed;
  if (d.flutter !== undefined) r.flutter = d.flutter;
  if (d.nearFade !== undefined) r.nearFade = d.nearFade;
  if (d.translucency !== undefined) r.translucency = d.translucency;
  if (d.stretch !== undefined) r.stretch = d.stretch;
  if (d.shape !== undefined) r.shape = d.shape;
  if (d.atlas !== undefined) r.flipbook = { grid: [d.atlas[0] ?? 1, d.atlas[1] ?? 1], mode: 'random' };
  return m;
}

/** Datos del prefab (módulos y/o claves antiguas) → configuración completa. */
export function normalizeParticleConfig(data: ParticleSystemComponentData | undefined): ParticleConfig {
  const config = defaults();
  const d = data ?? {};
  const target = config as unknown as Record<string, unknown>;
  deepMerge(target, fromLegacy(d));
  deepMerge(target, {
    maxParticles: d.maxParticles,
    worldSpace: d.worldSpace,
    material: d.material,
    emitter: d.emitter,
    spawn: d.spawn ? { ...d.spawn, size: d.spawn.size !== undefined ? vec3Of(d.spawn.size) : undefined } : undefined,
    init: d.init,
    forces: d.forces,
    overLife: d.overLife,
    render: d.render,
    lights: d.lights,
  } as Record<string, unknown>);
  if (data?.emitter?.burstCount === undefined && data?.burstCount === undefined) {
    config.emitter.burstCount = config.maxParticles;
  }
  config.render.ribbon.segments = clampSegments(config.render.ribbon.segments);
  return config;
}

export function clampSegments(n: number): number {
  return Math.max(2, Math.min(MAX_RIBBON_SEGMENTS, Math.round(n)));
}

/** Configuración → datos de prefab (formato por módulos), para copiar al .prefab. */
export function particleConfigToData(config: ParticleConfig): ParticleSystemComponentData {
  return structuredClone(config) as unknown as ParticleSystemComponentData;
}

export const CURVE_SAMPLES = 32;

function sortedKeys<T extends { t: number }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** Interpolación lineal por tramos entre claves (fuera del rango: la clave del extremo). */
function evaluate<T extends { t: number }>(keys: T[], t: number, lerp: (a: T, b: T, f: number) => void): void {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.t) return lerp(first, first, 0);
  if (t >= last.t) return lerp(last, last, 0);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b.t) return lerp(a, b, b.t > a.t ? (t - a.t) / (b.t - a.t) : 0);
  }
}

/**
 * Hornea las curvas de vida en 32 muestras (layout de ParticleCurves en
 * common/particles.wgsl): 32 × vec4 de color y luego 32 tamaños. 160 floats.
 */
export function bakeParticleCurves(config: ParticleConfig, out: Float32Array): void {
  const colors = sortedKeys(config.overLife.color.length ? config.overLife.color : [{ t: 0, color: [1, 1, 1, 1] }]);
  const sizes = sortedKeys(config.overLife.size.length ? config.overLife.size : [{ t: 0, value: 0.1 }]);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const t = i / (CURVE_SAMPLES - 1);
    evaluate(colors, t, (a, b, f) => {
      for (let c = 0; c < 4; c++) {
        const va = a.color[c] ?? 1;
        const vb = b.color[c] ?? 1;
        out[i * 4 + c] = va + (vb - va) * f;
      }
    });
    evaluate(sizes, t, (a, b, f) => {
      out[CURVE_SAMPLES * 4 + i] = a.value + (b.value - a.value) * f;
    });
  }
}
