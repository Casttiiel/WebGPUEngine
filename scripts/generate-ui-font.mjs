/**
 * Genera el atlas de la fuente de la UI a partir de una fuente vectorial del sistema.
 *
 *   node scripts/generate-ui-font.mjs [--font "Segoe UI"] [--weight 600]
 *
 * Salida (public/assets/textures/ui/fonts/):
 *   ui_font.png   atlas 16x16 celdas de 64 px: códigos 0-255 (Latin-1: tildes, ñ, ¿, ¡, ·)
 *   ui_font.json  métricas: avance horizontal de cada carácter (px de celda)
 *
 * Los glifos llevan un contorno oscuro para leerse sobre la escena 3D. Requiere sharp
 * (ya es dependencia del proyecto), que renderiza el texto vía SVG con las fuentes del SO.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const FONT = opt('--font', 'Segoe UI');
const WEIGHT = opt('--weight', '600');

const CELL = 64;
const GRID = 16;
const FONT_SIZE = 44;
const BASELINE = 47;
const PAD_X = 6; // margen izquierdo del glifo dentro de la celda
const STROKE = 5;
const OUT_DIR = path.join('public', 'assets', 'textures', 'ui', 'fonts');

const escapeXml = (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c;

const glyphSvg = (char) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">` +
  `<text x="${PAD_X}" y="${BASELINE}" font-family="${FONT}" font-weight="${WEIGHT}" font-size="${FONT_SIZE}" ` +
  `fill="white" stroke="#101018" stroke-width="${STROKE}" stroke-linejoin="round" paint-order="stroke" ` +
  `xml:space="preserve">${escapeXml(char)}</text></svg>`;

/** Columna más a la derecha con tinta (para calcular el avance). */
async function inkRight(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let right = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = info.width - 1; x > right; x--) {
      if (data[(y * info.width + x) * 4 + 3] > 24) {
        right = x;
        break;
      }
    }
  }
  return right;
}

const composites = [];
const advances = {};
for (let code = 32; code < 256; code++) {
  if (code >= 127 && code < 160) continue; // controles C1: sin glifo
  const char = String.fromCharCode(code);
  const png = await sharp(Buffer.from(glyphSvg(char))).png().toBuffer();
  const right = await inkRight(png);
  // Espacio y caracteres sin tinta: avance fijo. Resto: tinta + aire, sin contar el contorno doble.
  advances[code] = right < 0 ? Math.round(CELL * 0.28) : Math.max(8, right - PAD_X + 2);
  composites.push({ input: png, left: (code % GRID) * CELL, top: Math.floor(code / GRID) * CELL });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
await sharp({
  create: { width: CELL * GRID, height: CELL * GRID, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(composites)
  .png()
  .toFile(path.join(OUT_DIR, 'ui_font.png'));

const metrics = { font: FONT, weight: WEIGHT, cell: CELL, grid: GRID, padX: PAD_X, advances };
fs.writeFileSync(path.join(OUT_DIR, 'ui_font.json'), JSON.stringify(metrics) + '\n');
console.log(`ui_font.png + ui_font.json (${Object.keys(advances).length} glifos, ${FONT} ${WEIGHT})`);
