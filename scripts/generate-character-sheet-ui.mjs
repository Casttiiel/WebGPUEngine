// Genera public/assets/ui/character_sheet.json (ficha del personaje, tecla C).
// Dos raíces: un bloqueador transparente a pantalla completa (el ratón no llega al mundo) y
// el panel de la derecha. Las líneas de ataques/habilidades son un fondo común que coloca
// CharacterSheetController según el contenido.
import { writeFileSync } from 'node:fs';

const LINES = 40;
const W = 860;
const H = 960;
const PAD = 44;
const INNER = W - 2 * (PAD - 4);

const image = (alias, x, y, width, height, color, extra = {}) => ({
  name: alias,
  alias,
  type: 'image',
  x,
  y,
  width,
  height,
  imageParams: { texture: 'white.png', size: [width, height], color },
  ...extra,
});
const text = (alias, x, y, width, height, size, color, align = 'left', value = '') => ({
  name: alias,
  alias,
  type: 'text',
  x,
  y,
  width,
  height,
  textParams: { text: value, size: [size, size], color, align },
  blocksInput: false,
});

const GREY = [0.72, 0.72, 0.78, 1];
const GOLD = [1, 0.84, 0.5, 1];
const WHITE = [1, 1, 1, 1];

const stats = [0, 1, 2].flatMap((i) => {
  const x = PAD + i * 264;
  return [
    image(`sheet_stat_${i + 1}_box`, x, 192, 252, 108, [0.1, 0.1, 0.13, 1], { blocksInput: false }),
    text(`sheet_stat_${i + 1}_label`, x, 200, 252, 30, 22, GREY, 'center'),
    text(`sheet_stat_${i + 1}_value`, x, 236, 252, 56, 44, WHITE, 'center'),
  ];
});

const lines = Array.from({ length: LINES }, (_, i) =>
  text(`sheet_line_${i + 1}`, PAD, 0, INNER, 34, 24, WHITE),
);

const ui = [
  {
    ...image('sheet_blocker', 0, 0, 4000, 3000, [0, 0, 0, 0]),
    anchor: 'top-left',
    visible: false,
  },
  {
    ...image('sheet_panel', -(W + 48), 56, W + 8, H + 8, [0.75, 0.6, 0.3, 0.9]),
    anchor: 'top-right',
    visible: false,
    children: [
      image('sheet_bg', 4, 4, W, H, [0.05, 0.05, 0.07, 0.94]),
      text('sheet_name', PAD, 30, INNER, 64, 56, GOLD),
      text('sheet_role', PAD, 96, INNER, 36, 28, GREY),
      image('sheet_hp_bg', PAD, 144, INNER, 28, [0.02, 0.02, 0.02, 1], { blocksInput: false }),
      image('sheet_hp', PAD, 144, INNER, 28, [0.25, 0.75, 0.3, 1], { blocksInput: false }),
      text('sheet_hp_text', PAD, 140, INNER, 36, 26, WHITE, 'center'),
      ...stats,
      ...lines,
      text('sheet_hint', PAD, H - 44, INNER, 32, 22, GREY, 'center'),
    ],
  },
];

writeFileSync(
  new URL('../public/assets/ui/character_sheet.json', import.meta.url),
  JSON.stringify(ui, null, 2) + '\n',
);
console.log(`character_sheet.json: ${LINES} líneas`);
