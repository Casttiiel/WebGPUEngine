// ---------------------------------------------------------------------------
// HeightmapGenerator — fBm value noise, no external dependencies
// ---------------------------------------------------------------------------

export interface NoiseParams {
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  /** Base frequency multiplier applied to pixel coordinates before noise. */
  scale?: number;
  seed?: number;
  /** Optional remapping curve applied after fBm. Receives [0,1], returns [0,1]. */
  heightCurve?: (t: number) => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Integer hash (bijective 32-bit scramble, returns [0,1]). */
function hash21(ix: number, iy: number, seedOffset: number): number {
  let h = ((ix * 1619) ^ (iy * 31337) ^ seedOffset) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Bilinear value noise in [0,1]. */
function valueNoise(x: number, y: number, seedOffset: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;

  // Smoothstep kernel
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = hash21(xi, yi, seedOffset);
  const b = hash21(xi + 1, yi, seedOffset);
  const c = hash21(xi, yi + 1, seedOffset);
  const d = hash21(xi + 1, yi + 1, seedOffset);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractional Brownian Motion over value noise, output in [0,1]. */
function fbm(
  x: number,
  y: number,
  octaves: number,
  persistence: number,
  lacunarity: number,
  seed: number,
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let totalAmplitude = 0;

  for (let i = 0; i < octaves; i++) {
    // Each octave uses a different seed offset to break correlation
    value += valueNoise(x * frequency, y * frequency, seed + i * 997) * amplitude;
    totalAmplitude += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / totalAmplitude;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class HeightmapGenerator {
  /**
   * Generates a `width × depth` heightmap as a flat Float32Array (row-major, Z-major).
   * All values are in [0, 1] (before maxHeight scaling, which TerrainData handles).
   */
  static generate(width: number, depth: number, params?: NoiseParams): Float32Array {
    const {
      octaves = 6,
      persistence = 0.5,
      lacunarity = 2.0,
      scale = 0.003,
      seed = 0,
      heightCurve,
    } = params ?? {};

    const out = new Float32Array(width * depth);

    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        let v = fbm(x * scale, z * scale, octaves, persistence, lacunarity, seed);
        v = Math.max(0, Math.min(1, v));
        if (heightCurve) v = heightCurve(v);
        out[z * width + x] = v;
      }
    }

    return out;
  }
}
