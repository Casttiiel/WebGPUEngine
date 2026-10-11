/**
 * Genera las texturas de las superficies del juego táctico (decals en el suelo).
 *
 *   node scripts/generate-tactical-textures.mjs
 *
 * Salida (public/assets/textures/tactical/):
 *   surface_fire.png  mancha de brasas (naranja/rojo, borde irregular)
 *   surface_oil.png   charco de aceite (marrón oscuro con brillo)
 *
 * Son SVG rasterizados con sharp (dependencia del proyecto). El borde irregular sale de una
 * semilla fija: las texturas son reproducibles.
 */
import sharp from 'sharp';
import path from 'node:path';

const SIZE = 256;
const OUT = path.join('public', 'assets', 'textures', 'tactical');

/** Contorno de mancha: círculo con radio perturbado (semilla fija). */
function blob(seed, radius, wobble, points = 28) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const c = SIZE / 2;
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = radius * (1 - wobble + rnd() * wobble * 2);
    pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
  }
  // Curva suave por los puntos medios (bezier cuadrática).
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let d = `M ${mid(pts.at(-1), pts[0]).join(' ')}`;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    d += ` Q ${p.join(' ')} ${mid(p, q).join(' ')}`;
  }
  return `${d} Z`;
}

const textures = {
  'surface_fire.png': `
    <defs>
      <radialGradient id="g" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd25a" stop-opacity="0.95"/>
        <stop offset="45%" stop-color="#ff7a1a" stop-opacity="0.9"/>
        <stop offset="80%" stop-color="#c22a0a" stop-opacity="0.75"/>
        <stop offset="100%" stop-color="#3a0a02" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="${blob(7, 118, 0.12)}" fill="url(#g)"/>
    <path d="${blob(13, 70, 0.3, 14)}" fill="#ffe08a" fill-opacity="0.35"/>`,
  'surface_oil.png': `
    <defs>
      <radialGradient id="g" cx="45%" cy="40%" r="60%">
        <stop offset="0%" stop-color="#5a4a2a" stop-opacity="0.95"/>
        <stop offset="70%" stop-color="#1c160c" stop-opacity="0.92"/>
        <stop offset="100%" stop-color="#0c0904" stop-opacity="0.85"/>
      </radialGradient>
    </defs>
    <path d="${blob(3, 116, 0.14)}" fill="url(#g)"/>
    <ellipse cx="105" cy="95" rx="34" ry="14" fill="#c8b27a" fill-opacity="0.25" transform="rotate(-25 105 95)"/>`,
};

for (const [name, body] of Object.entries(textures)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, name));
  console.log(`✓ ${path.join(OUT, name)}`);
}
