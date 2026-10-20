import { ResourceManager } from '../../core/engine/ResourceManager';
import type { ProbeFaces } from '../core/managers/ProbeManager';

/**
 * Baked reflection probe radiance, `assets/probes/{name}_env.bin`:
 *   header  'PRB1' · u32 size · u32 format (1 = rgba16float) · u32 faces (6)
 *   data    6 faces × size² × RGBA half floats, WebGPU cube face order/orientation, linear HDR
 * Older bakes only have `{name}_cubemap_T.png` (8-bit, clamped, Y-flipped T cross): still
 * read, as a fallback.
 */
const MAGIC = 0x31425250; // 'PRB1' little endian
const HEADER_BYTES = 16;

export function encodeProbeFaces(faces: ProbeFaces): ArrayBuffer {
  const out = new ArrayBuffer(HEADER_BYTES + faces.data.byteLength);
  new Uint32Array(out, 0, 4).set([MAGIC, faces.size, 1, 6]);
  new Uint16Array(out, HEADER_BYTES).set(faces.data);
  return out;
}

function decodeProbeFaces(buffer: ArrayBuffer): ProbeFaces {
  const [magic, size, format, count] = new Uint32Array(buffer, 0, 4);
  if (magic !== MAGIC || format !== 1 || count !== 6) throw new Error('not a PRB1 probe file');
  return { size: size!, data: new Uint16Array(buffer, HEADER_BYTES, 6 * size! * size! * 4) };
}

/** Loads a probe's radiance: the HDR .bin, else the legacy PNG. null if neither exists. */
export async function loadProbeFaces(name: string): Promise<ProbeFaces | null> {
  try {
    const response = await ResourceManager.fetch(`assets/probes/${name}_env.bin`);
    return decodeProbeFaces(await response.arrayBuffer());
  } catch {
    // no HDR bake yet
  }
  try {
    const response = await ResourceManager.fetch(`assets/probes/${name}_cubemap_T.png`);
    return await decodeLegacyCross(await response.blob());
  } catch {
    return null;
  }
}

// T cross: [top] over [left][front][right][back] over [bottom]; face order +X −X +Y −Y +Z −Z.
const CROSS_CELLS: Array<[number, number]> = [
  [2, 1],
  [0, 1],
  [1, 0],
  [1, 2],
  [1, 1],
  [3, 1],
];

async function decodeLegacyCross(blob: Blob): Promise<ProbeFaces> {
  const image = await createImageBitmap(blob);
  const size = image.width / 4;
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  const data = new Uint16Array(6 * size * size * 4);
  for (let face = 0; face < 6; face++) {
    const [cx, cy] = CROSS_CELLS[face]!;
    for (let y = 0; y < size; y++) {
      // The exporter flipped every face vertically: undo it.
      const srcRow = cy * size + (size - 1 - y);
      for (let x = 0; x < size; x++) {
        const src = (srcRow * image.width + cx * size + x) * 4;
        const dst = ((face * size + y) * size + x) * 4;
        for (let c = 0; c < 3; c++) data[dst + c] = toHalf(pixels[src + c]! / 255);
        data[dst + 3] = toHalf(1);
      }
    }
  }
  image.close();
  return { size, data };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → IEEE half (round to nearest, flush tiny values, clamp to 65504). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7bff;
  const half = sign | (exp << 10) | (mant >>> 13);
  return half + ((mant >>> 12) & 1); // round
}
