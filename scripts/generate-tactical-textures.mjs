/**
 * Genera las texturas del juego táctico: superficies (decals en el suelo) e iconos de estado.
 *
 *   node scripts/generate-tactical-textures.mjs
 *
 * Salida (public/assets/textures/tactical/):
 *   surface_fire.png  mancha de brasas (naranja/rojo, borde irregular)
 *   surface_oil.png   charco de aceite (marrón oscuro con brillo)
 *   status_fear.png   icono del estado "miedo" (sobre la cabeza de la unidad)
 *   ash_flake.png     copo de ceniza (partículas que caen del cielo, estilo Nacidos de la Bruma)
 *   ash_flakes.png    atlas 2×2 (512 px) de copos de ceniza distintos: bordes dentados de papel
 *                     quemado, más oscuros en el borde, con vetas (cada partícula usa uno)
 *   aim_*.png         indicador de empujar (flecha en el suelo): cuerpo, chevrones y punta en
 *                     dos colores (_ok: no golpea a nadie, _hit: golpea), hueco donde acaba el
 *                     objeto y marca de impacto. En la textura "adelante" es hacia abajo (+v).
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
  // Icono de estado "miedo" (sobre la cabeza de la unidad asustada).
  'status_fear.png': `
    <circle cx="128" cy="128" r="112" fill="#6a2c9c" stroke="#16081f" stroke-width="16"/>
    <circle cx="128" cy="128" r="96" fill="none" stroke="#c9a4ff" stroke-width="6" stroke-opacity="0.6"/>
    <ellipse cx="92" cy="104" rx="20" ry="30" fill="#ffffff"/>
    <ellipse cx="164" cy="104" rx="20" ry="30" fill="#ffffff"/>
    <circle cx="92" cy="112" r="9" fill="#16081f"/>
    <circle cx="164" cy="112" r="9" fill="#16081f"/>
    <path d="M68 76 L110 58 M188 76 L146 58" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>
    <ellipse cx="128" cy="176" rx="26" ry="32" fill="#16081f" stroke="#ffffff" stroke-width="8"/>`,
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

// Indicador de empujar: claro (no golpea) o rojo (golpea a alguien), con borde oscuro.
const AIM_COLORS = {
  ok: { fill: '#fff6c8', edge: '#2a1c06' },
  hit: { fill: '#ff5236', edge: '#3a0603' },
};
for (const [variant, { fill, edge }] of Object.entries(AIM_COLORS)) {
  // Cuerpo: banda a lo largo (se estira con la longitud de la flecha).
  textures[`aim_shaft_${variant}.png`] = `
    <rect x="40" y="0" width="176" height="256" fill="${edge}" fill-opacity="0.8"/>
    <rect x="62" y="0" width="132" height="256" fill="${fill}" fill-opacity="0.75"/>`;
  // Chevrón (apunta hacia abajo = hacia donde sale el objeto).
  textures[`aim_chevron_${variant}.png`] = `
    <path d="M28 70 L128 170 L228 70" fill="none" stroke="${edge}" stroke-width="64" stroke-linejoin="miter" stroke-linecap="square"/>
    <path d="M28 70 L128 170 L228 70" fill="none" stroke="${fill}" stroke-width="40" stroke-linejoin="miter" stroke-linecap="square"/>`;
  // Punta.
  textures[`aim_head_${variant}.png`] = `
    <path d="M16 24 L240 24 L128 236 Z" fill="${edge}"/>
    <path d="M44 40 L212 40 L128 202 Z" fill="${fill}"/>`;
}
// Dónde acaba el objeto: esquinas de un cuadrado.
textures['aim_landing.png'] = ['M16 80 V16 H80', 'M176 16 H240 V80', 'M240 176 V240 H176', 'M80 240 H16 V176']
  .map(
    (d) => `
    <path d="${d}" fill="none" stroke="#2a1c06" stroke-width="34" stroke-linecap="square"/>
    <path d="${d}" fill="none" stroke="#fff0b0" stroke-width="18" stroke-linecap="square"/>`,
  )
  .join('');
// Impacto: estrella roja en el punto del choque.
{
  const spikes = 10;
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 122 : 62;
    d += `${i === 0 ? 'M' : 'L'}${(128 + Math.cos(a) * r).toFixed(1)} ${(128 + Math.sin(a) * r).toFixed(1)} `;
  }
  textures['aim_impact.png'] = `
    <path d="${d}Z" fill="#3a0603"/>
    <path d="${d}Z" fill="#ff4a30" transform="translate(128 128) scale(0.8) translate(-128 -128)"/>
    <circle cx="128" cy="128" r="30" fill="#ffd25a"/>`;
}

// Copo de ceniza: mancha irregular de bordes suaves (el gris lo pone la partícula; se suman).
textures['ash_flake.png'] = `
    <defs>
      <radialGradient id="g" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="60%" stop-color="#ffffff" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="${blob(29, 110, 0.35, 9)}" fill="url(#g)"/>`;

// Atlas de copos de ceniza (2×2 celdas de 256 px; se genera aparte, es de 512 px).
function ashFlake(seed, cx, cy) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  // Contorno dentado: radio irregular a baja frecuencia (forma) + dientes (borde quemado).
  const n = 46;
  const lobes = 2 + Math.floor(rnd() * 3);
  const phase = rnd() * Math.PI * 2;
  const stretch = 0.55 + rnd() * 0.35;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 92 * (0.72 + 0.28 * Math.sin(a * lobes + phase)) * (0.82 + rnd() * 0.3);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * stretch]);
  }
  const d = `M ${pts.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join(' L ')} Z`;
  // Vetas (fibras del papel/hoja quemada).
  let veins = '';
  for (let v = 0; v < 3; v++) {
    const a = rnd() * Math.PI;
    const len = 40 + rnd() * 40;
    const x0 = cx - Math.cos(a) * len, y0 = cy - Math.sin(a) * len * stretch;
    const x1 = cx + Math.cos(a) * len, y1 = cy + Math.sin(a) * len * stretch;
    veins += `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${(cx + (rnd() - 0.5) * 30).toFixed(1)} ${(cy + (rnd() - 0.5) * 30).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="#5a5450" stroke-width="${(2 + rnd() * 2).toFixed(1)}" fill="none" stroke-opacity="0.7"/>`;
  }
  const id = `g${seed}`;
  return `
    <defs>
      <radialGradient id="${id}" cx="${cx}" cy="${cy}" r="96" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#b8b2ac"/>
        <stop offset="65%" stop-color="#8f8882"/>
        <stop offset="100%" stop-color="#3e3936"/>
      </radialGradient>
    </defs>
    <path d="${d}" fill="url(#${id})" stroke="#2a2624" stroke-width="5" stroke-linejoin="round"/>
    ${veins}`;
}
{
  const body = [ashFlake(11, 128, 128), ashFlake(23, 384, 128), ashFlake(37, 128, 384), ashFlake(53, 384, 384)].join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, 'ash_flakes.png'));
  console.log(`✓ ${path.join(OUT, 'ash_flakes.png')}`);
}

for (const [name, body] of Object.entries(textures)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, name));
  console.log(`✓ ${path.join(OUT, name)}`);
}
