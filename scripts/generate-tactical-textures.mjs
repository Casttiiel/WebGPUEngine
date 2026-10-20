/**
 * Genera las texturas del juego táctico: superficies (decals en el suelo) e iconos de estado.
 *
 *   node scripts/generate-tactical-textures.mjs
 *
 * Salida (public/assets/textures/tactical/):
 *   surface_fire.png  mancha de brasas (naranja/rojo, borde irregular)
 *   surface_oil.png   charco de aceite (marrón oscuro con brillo)
 *   status_fear.png   icono del estado "miedo" (sobre la cabeza de la unidad)
 *   cover_shield.png  escudo de cobertura (al moverse, por cada dirección cubierta)
 *   zone_bendalloy.png  burbuja de bendaleo (decal: círculo translúcido con borde)
 *   zone_cadmium.png    burbuja de cadmio (el mismo decal, en ámbar y con el borde a trazos)
 *   zone_fortune.png, zone_connection.png, zone_investiture.png
 *                       zonas espirituales (Fortuna dorada, Conexión violeta, Investidura blanca)
 *   status_*.png      iconos del resto de estados: Seco, Aturdido, Derribado, Marcado, Burbuja
 *                     de acero y mente de hierro (Ligero / Pesado)
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

/** Icono de estado: disco de color con borde oscuro, aro claro y un símbolo encima. */
const statusIcon = (fill, ring, symbol) => `
    <circle cx="128" cy="128" r="112" fill="${fill}" stroke="#16081f" stroke-width="16"/>
    <circle cx="128" cy="128" r="96" fill="none" stroke="${ring}" stroke-width="6" stroke-opacity="0.6"/>
    ${symbol}`;

const textures = {
  // Escudo de cobertura (destino al moverse): hacia dónde tapa.
  'cover_shield.png': `
    <path d="M128 28 L212 60 V124 C212 176 176 212 128 232 C80 212 44 176 44 124 V60 Z" fill="#3a6ea8" stroke="#0e1a28" stroke-width="16" stroke-linejoin="round"/>
    <path d="M128 56 L186 78 V124 C186 162 160 188 128 204 Z" fill="#9cc4ee"/>`,
  // Burbuja de bendaleo: disco translúcido azulado con el borde marcado.
  'zone_bendalloy.png': `
    <circle cx="128" cy="128" r="118" fill="#9cc8ff" fill-opacity="0.16" stroke="#e2f0ff" stroke-width="7" stroke-opacity="0.9"/>
    <circle cx="128" cy="128" r="104" fill="none" stroke="#b8d8ff" stroke-width="3" stroke-opacity="0.5" stroke-dasharray="10 12"/>`,
  // Burbuja de cadmio (tiempo lento): disco ámbar con el borde a trazos largos.
  'zone_cadmium.png': `
    <circle cx="128" cy="128" r="118" fill="#ffb347" fill-opacity="0.18" stroke="#ffe0a8" stroke-width="7" stroke-opacity="0.9" stroke-dasharray="26 10"/>
    <circle cx="128" cy="128" r="102" fill="none" stroke="#ffc878" stroke-width="3" stroke-opacity="0.5"/>`,
  // Zona espiritual (fortune): disco translúcido con doble borde y un anillo de puntos.
  'zone_fortune.png': `
    <circle cx="128" cy="128" r="118" fill="#ffd257" fill-opacity="0.15" stroke="#fff0b8" stroke-width="6" stroke-opacity="0.9"/>
    <circle cx="128" cy="128" r="108" fill="none" stroke="#fff0b8" stroke-width="2" stroke-opacity="0.7"/>
    <circle cx="128" cy="128" r="96" fill="none" stroke="#ffd257" stroke-width="5" stroke-opacity="0.55" stroke-dasharray="2 14" stroke-linecap="round"/>`,
  // Zona espiritual (connection): disco translúcido con doble borde y un anillo de puntos.
  'zone_connection.png': `
    <circle cx="128" cy="128" r="118" fill="#a974ff" fill-opacity="0.15" stroke="#e2d0ff" stroke-width="6" stroke-opacity="0.9"/>
    <circle cx="128" cy="128" r="108" fill="none" stroke="#e2d0ff" stroke-width="2" stroke-opacity="0.7"/>
    <circle cx="128" cy="128" r="96" fill="none" stroke="#a974ff" stroke-width="5" stroke-opacity="0.55" stroke-dasharray="2 14" stroke-linecap="round"/>`,
  // Zona espiritual (investiture): disco translúcido con doble borde y un anillo de puntos.
  'zone_investiture.png': `
    <circle cx="128" cy="128" r="118" fill="#dff0ff" fill-opacity="0.15" stroke="#ffffff" stroke-width="6" stroke-opacity="0.9"/>
    <circle cx="128" cy="128" r="108" fill="none" stroke="#ffffff" stroke-width="2" stroke-opacity="0.7"/>
    <circle cx="128" cy="128" r="96" fill="none" stroke="#dff0ff" stroke-width="5" stroke-opacity="0.55" stroke-dasharray="2 14" stroke-linecap="round"/>`,
  // Ritmo: tres marcas en racha.
  'status_rhythm.png': statusIcon(
    '#3c6e3a',
    '#c8f0c0',
    `<path d="M70 168 L98 88 M114 168 L142 88 M158 168 L186 88" stroke="#ffffff" stroke-width="18" stroke-linecap="round"/>`,
  ),
  // Peltre avivado: puño.
  'status_pewter.png': statusIcon(
    '#8a8f96',
    '#f0f4f8',
    `<rect x="78" y="84" width="100" height="74" rx="18" fill="#ffffff"/>
    <path d="M78 112 H178 M112 84 V112 M145 84 V112" stroke="#8a8f96" stroke-width="8"/>
    <rect x="96" y="150" width="64" height="40" rx="10" fill="#ffffff"/>`,
  ),
  // Arrastre de peltre: gota de cansancio.
  'status_pewter_drag.png': statusIcon(
    '#4a4e54',
    '#a8adb4',
    `<path d="M128 60 C 96 112 84 136 84 156 A44 44 0 0 0 172 156 C172 136 160 112 128 60 Z" fill="#ffffff"/>`,
  ),
  // Mente de oro: cruz de curación.
  'status_gold_heal.png': statusIcon(
    '#a8841c',
    '#fff0b8',
    `<path d="M128 64 V192 M64 128 H192" stroke="#ffffff" stroke-width="30" stroke-linecap="round"/>`,
  ),
  // Seco: vial vacío.
  'status_drained.png': statusIcon(
    '#5a4a3c',
    '#d8c3a8',
    `<path d="M108 58 H148 M114 58 V100 L84 176 Q80 196 100 196 H156 Q176 196 172 176 L142 100 V58" fill="none" stroke="#ffffff" stroke-width="12" stroke-linejoin="round"/>`,
  ),
  // Aturdido: estrellas girando.
  'status_stunned.png': statusIcon(
    '#c9a020',
    '#fff2b0',
    `<path d="M128 56 L140 92 L178 92 L148 114 L160 150 L128 128 L96 150 L108 114 L78 92 L116 92 Z" fill="#ffffff"/>
    <ellipse cx="128" cy="170" rx="64" ry="18" fill="none" stroke="#ffffff" stroke-width="10"/>`,
  ),
  // Derribado: flecha hacia el suelo.
  'status_prone.png': statusIcon(
    '#b0501c',
    '#ffc8a0',
    `<path d="M128 52 V150 M88 112 L128 152 L168 112" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M70 188 H186" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>`,
  ),
  // Marcado: mira.
  'status_marked.png': statusIcon(
    '#a8201c',
    '#ffb0a8',
    `<circle cx="128" cy="128" r="46" fill="none" stroke="#ffffff" stroke-width="12"/>
    <path d="M128 50 V96 M128 160 V206 M50 128 H96 M160 128 H206" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>
    <circle cx="128" cy="128" r="10" fill="#ffffff"/>`,
  ),
  // Burbuja de acero: arcos de una burbuja.
  'status_steel_bubble.png': statusIcon(
    '#2c5a8a',
    '#b8dcff',
    `<circle cx="128" cy="128" r="62" fill="#ffffff" fill-opacity="0.18" stroke="#ffffff" stroke-width="10"/>
    <path d="M94 104 Q104 82 128 76" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>`,
  ),
  // Mente de hierro, Ligero: flecha hacia arriba.
  'status_iron_light.png': statusIcon(
    '#6f7780',
    '#e4ecf4',
    `<path d="M128 200 V84 M86 124 L128 80 L170 124" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  // Mente de hierro, Pesado: pesa.
  'status_iron_heavy.png': statusIcon(
    '#2e3238',
    '#a8b0b8',
    `<path d="M104 92 A24 24 0 1 1 152 92" fill="none" stroke="#ffffff" stroke-width="12"/>
    <path d="M90 104 H166 L184 192 H72 Z" fill="#ffffff"/>`,
  ),
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
