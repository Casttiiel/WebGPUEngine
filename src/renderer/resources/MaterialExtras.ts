/**
 * Extra material parameters, written after MaterialFactors (offset 48) in the factors
 * uniform. Only the shaders that need them declare them (gbuffer/pom_common.wgsl —
 * keep both in the same order). A .mat sets them by name; missing ones take the default.
 */
export const MATERIAL_EXTRAS = [
  // POM_SHADOW
  { key: 'pomShadow', default: [0] }, // self-shadow strength (0 = off)
  // LAYER: second material height-blended over the base
  { key: 'layerCoverage', default: [0.5] }, // 0 = base only, 1 = layer everywhere
  { key: 'layerNoiseScale', default: [0.35] }, // world mask frequency (cycles per metre)
  { key: 'layerSharpness', default: [0.08] }, // height-blend transition width (0–1 height)
  { key: 'layerUvScale', default: [0] }, // layer tiling; 0 = same as uvXScale
  // ANTI_TILE
  { key: 'antiTileScale', default: [0.15] }, // variation frequency, in texture tiles
  // DIRT
  { key: 'cavityDirt', default: [0] }, // grime in the low parts of the relief (0–1)
  { key: 'baseDirtHeight', default: [0] }, // grime band at the base of the box (metres)
  { key: 'dirtColor', default: [0.16, 0.14, 0.12] }, // grime albedo (linear)
  { key: 'baseDirtStrength', default: [0.75] },
  { key: 'layerTint', default: [1, 1, 1] }, // multiplies the layer's albedo
  { key: 'layerHeightOffset', default: [0] }, // raises (+) / sinks (−) the layer's height
] as const;

export type MaterialExtrasData = Record<string, number | number[]>;

/** 16 floats = 64 bytes. */
export const MATERIAL_EXTRAS_FLOATS = 16;

/** Known extra keys present in `source` (a .mat's data or another material's extras). */
export function pickExtras(source: Record<string, unknown> | undefined): MaterialExtrasData {
  const out: MaterialExtrasData = {};
  if (!source) return out;
  for (const { key } of MATERIAL_EXTRAS) {
    const v = source[key];
    if (typeof v === 'number' || Array.isArray(v)) out[key] = v as number | number[];
  }
  return out;
}

export function packExtras(extras: MaterialExtrasData): Float32Array {
  const data = new Float32Array(MATERIAL_EXTRAS_FLOATS);
  let i = 0;
  for (const { key, default: def } of MATERIAL_EXTRAS) {
    const v = extras[key];
    const values = v === undefined ? def : typeof v === 'number' ? [v] : v;
    for (let k = 0; k < def.length; k++) data[i++] = values[k] ?? def[k]!;
  }
  return data;
}
