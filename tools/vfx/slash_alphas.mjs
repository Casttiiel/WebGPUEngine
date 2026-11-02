// Generates the slash alpha masks used by trail/slash_alpha.fs (after Eduardo Braz's
// "Slash + Mini Tutorial": a brush-shaped mask times streak lines decides the slash's shape).
// Layout of every mask: X = along the trail (0 = head, newest → 1 = tail, oldest),
//                       Y = across (0 = outer edge, the weapon tip → 1 = inner side).
//   node tools/vfx/slash_alphas.mjs   → public/assets/textures/vfx/slash_alpha_*.png
//                                       + .anim-out/slash_alphas.png (gallery, previewed on an arc)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
const OUT = path.join(ROOT, 'public/assets/textures/vfx');
const W = 512, H = 256;

// ── noise ──────────────────────────────────────────────────────────────────────
const hash = (i, seed = 0) => {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const noise1 = (x, seed = 0) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
};
const noise2 = (x, y, seed = 0) => {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash(a * 57 + b * 131, seed);
  return (h(ix, iy) * (1 - ux) + h(ix + 1, iy) * ux) * (1 - uy) + (h(ix, iy + 1) * (1 - ux) + h(ix + 1, iy + 1) * ux) * uy;
};
const fbm1 = (x, seed) => noise1(x, seed) * 0.6 + noise1(x * 2.3, seed + 1) * 0.3 + noise1(x * 5.1, seed + 2) * 0.1;
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** Soft ramp-in at the head so the leading edge is not a hard cut. */
const headIn = (u) => sstep(0.0, 0.035, u);
/** Fades the top/bottom borders to zero (the ribbon edge must not be visible as a line). */
const border = (v) => sstep(0.0, 0.03, v) * sstep(1.0, 0.94, v);

/**
 * Streak set: `count` lines across the ribbon, each with its own lane, width, length and
 * brightness, optionally broken into dashes. Returns the max over the lines.
 */
function streaks(u, v, { count, seed, width = [0.004, 0.014], length = [0.35, 0.95], start = [0, 0.08], dash = 0, dashScale = 30, taper = 1, outerBias = 0 }) {
  let best = 0;
  for (let i = 0; i < count; i++) {
    const r = (k) => hash(i * 13 + k, seed);
    let lane = (i + 0.2 + r(1) * 0.6) / count;
    lane = Math.pow(lane, 1 + outerBias); // crowd lanes toward the outer edge
    const w0 = width[0] + (width[1] - width[0]) * r(2);
    const s = start[0] + (start[1] - start[0]) * r(3);
    const len = length[0] + (length[1] - length[0]) * r(4);
    const b = 0.55 + 0.45 * r(5);
    if (u < s) continue;
    const along = (u - s) / len; // 0 at the line's head, 1 at its end
    if (along > 1) continue;
    const w = w0 * (1 - taper * 0.75 * along); // thinner toward the end
    const wobble = (noise1(u * 6 + i * 3.1, seed) - 0.5) * 0.012;
    const d = (v - lane - wobble) / w;
    let m = Math.exp(-d * d) * b * (1 - sstep(0.55, 1.0, along));
    if (dash > 0) {
      const g = noise1(u * dashScale + i * 7.7, seed + 9);
      m *= mix(1, sstep(0.35, 0.55, g), dash * sstep(0.05, 0.35, along));
    }
    best = Math.max(best, m);
  }
  return best;
}
const mix = (a, b, t) => a + (b - a) * t;

// ── the masks ───────────────────────────────────────────────────────────────────
const MASKS = {
  /** Tutorial Mask1 × Mask2: solid brushed head, frayed streaky tail, denser at the outer edge. */
  brush(u, v) {
    const tailLen = 0.35 + 0.6 * fbm1(v * 38, 3);
    const body = sstep(tailLen, tailLen - 0.3, u) * (1 - 0.55 * v);
    const fine = 0.55 + 0.45 * noise2(v * 140, u * 2.5, 4);
    const lines = streaks(u, v, { count: 26, seed: 5, width: [0.004, 0.012], length: [0.5, 1.0], outerBias: 0.4 });
    return headIn(u) * border(v) * clamp01(body * fine * 0.75 + lines * 0.7);
  },
  /** Many thin parallel lines of different lengths (the orange slash of the tutorial). */
  lines(u, v) {
    const l = streaks(u, v, { count: 34, seed: 11, width: [0.003, 0.011], length: [0.25, 0.95], start: [0, 0.12], outerBias: 0.3 });
    const glow = sstep(0.7, 0.0, u) * (1 - v) * 0.12;
    return headIn(u) * border(v) * clamp01(l + glow);
  },
  /** A few thick soft ribbons that taper away (the blue wisps). */
  wisp(u, v) {
    const l = streaks(u, v, { count: 5, seed: 21, width: [0.035, 0.07], length: [0.6, 1.0], start: [0, 0.05], taper: 1.2 });
    const core = streaks(u, v, { count: 5, seed: 21, width: [0.008, 0.016], length: [0.6, 1.0], start: [0, 0.05], taper: 1.2 });
    return headIn(u) * border(v) * clamp01(l * 0.65 + core * 0.6);
  },
  /** Streaks shattered into dashes toward the tail (the purple one): energy breaking apart. */
  shatter(u, v) {
    const l = streaks(u, v, { count: 30, seed: 31, width: [0.004, 0.014], length: [0.4, 1.0], dash: 1, dashScale: 26, outerBias: 0.2 });
    return headIn(u) * border(v) * clamp01(l * 1.1);
  },
  /** Solid crescent: thick at the head, tapering to a point, hard bright outer edge. */
  crescent(u, v) {
    const thick = 0.92 * Math.pow(1 - u, 1.4);
    const inside = sstep(thick, thick - 0.08, v);
    const edge = Math.exp(-v * 18);
    const fine = 0.7 + 0.3 * noise2(v * 90, u * 3, 41);
    return headIn(u) * border(v) * clamp01(inside * (0.35 + 0.65 * (1 - v / Math.max(thick, 0.01))) * fine + edge * inside * 0.5);
  },
  /** Flame tongues licking back from a solid head band (the teal V). */
  flame(u, v) {
    let best = 0;
    for (let i = 0; i < 9; i++) {
      const lane = (i + 0.5) / 9 + (hash(i, 51) - 0.5) * 0.06;
      const len = 0.45 + 0.5 * hash(i, 52);
      const along = u / len;
      if (along > 1) continue;
      const w = 0.075 * (1 - along) ** 1.2 + 0.004;
      const d = (v - lane - Math.sin(u * 9 + i) * 0.015) / w;
      best = Math.max(best, Math.exp(-d * d) * (1 - sstep(0.6, 1, along)) * (0.6 + 0.4 * hash(i, 53)));
    }
    const band = sstep(0.22, 0.0, u);
    const fine = 0.75 + 0.25 * noise2(v * 60, u * 4, 54);
    return headIn(u) * border(v) * clamp01((best + band * 0.8) * fine);
  },
};

fs.mkdirSync(OUT, { recursive: true });
const gallery = [];
for (const [name, fn] of Object.entries(MASKS)) {
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) buf[y * W + x] = Math.round(255 * clamp01(fn((x + 0.5) / W, (y + 0.5) / H)));
  const file = path.join(OUT, `slash_alpha_${name}.png`);
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(file);
  gallery.push({ name, buf });
  console.log('wrote', path.relative(ROOT, file));
}

// ── gallery: each mask flat, and wrapped on an arc with a blue ramp like the shader ──
const CW = 520, CH = 560;
const tiles = [];
for (const [i, { name, buf }] of gallery.entries()) {
  const flat = await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).resize(500, 250).png().toBuffer();
  const arc = Buffer.alloc(500 * 270 * 3);
  const cx = 250, cy = 290, r0 = 120, r1 = 270;
  for (let y = 0; y < 270; y++)
    for (let x = 0; x < 500; x++) {
      const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
      const a = Math.atan2(dx, -dy); // 0 = up
      const u = (a + 1.3) / 2.6; // head on the left
      const v = (r1 - r) / (r1 - r0);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const m = buf[Math.min(H - 1, Math.floor(v * H)) * W + Math.min(W - 1, Math.floor(u * W))] / 255;
      const I = m * (0.6 + 0.6 * (1 - v));
      const c = [0.06, 0.32, 1.0].map((t) => Math.min(1, mix(t * 0.5, t * 1.5, sstep(0.05, 0.5, I)) * I + sstep(0.85, 1.2, I) * 0.6));
      arc.set(c.map((k) => Math.round(255 * Math.min(1, k))), (y * 500 + x) * 3);
    }
  const arcPng = await sharp(arc, { raw: { width: 500, height: 270, channels: 3 } }).png().toBuffer();
  const label = Buffer.from(`<svg width="500" height="24"><text x="4" y="18" font-family="monospace" font-size="16" fill="#fff">slash_alpha_${name}</text></svg>`);
  const left = (i % 3) * CW + 10, top = Math.floor(i / 3) * CH + 4;
  tiles.push({ input: label, left, top }, { input: flat, left, top: top + 26 }, { input: arcPng, left, top: top + 282 });
}
await sharp({ create: { width: CW * 3, height: CH * 2, channels: 3, background: '#08080c' } })
  .composite(tiles)
  .png()
  .toFile(path.join(ROOT, '.anim-out/slash_alphas.png'));
console.log('gallery .anim-out/slash_alphas.png');
