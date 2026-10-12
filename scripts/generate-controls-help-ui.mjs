// Genera public/assets/ui/controls_help.json (ayuda de controles, tecla H).
// Un recordatorio siempre visible ("H: controles") y el panel con las teclas, que
// ControlsHelpController muestra u oculta.
import { writeFileSync } from 'node:fs';

const W = 560;
const PAD = 22;
const KEY_WIDTH = 210;
const ROW = 32;

/** [teclas, qué hacen]; null = separador entre grupos. */
const CONTROLS = [
  ['Click izquierdo', 'Mover, atacar o interactuar'],
  ['Click derecho / Esc', 'Cancelar la acción armada'],
  ['1-4 / Tab', 'Elegir personaje (exploración)'],
  ['1-7', 'Hotbar (combate)'],
  ['Espacio', 'Terminar el turno'],
  null,
  ['WASD / bordes', 'Mover la cámara'],
  ['Q / E', 'Girar la cámara'],
  ['Rueda', 'Zoom'],
  ['Botón central', 'Arrastrar (con Shift: girar)'],
  ['F / Inicio', 'Seguir / centrar al personaje'],
  null,
  ['C', 'Ficha del personaje'],
  ['R', 'Reiniciar el encuentro'],
  ['H', 'Mostrar / ocultar esta ayuda'],
];

const GOLD = [1, 0.84, 0.5, 1];
const GREY = [0.75, 0.75, 0.8, 1];
const WHITE = [1, 1, 1, 1];

const text = (alias, x, y, width, height, size, color, value, align = 'left') => ({
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

const rows = [];
let y = 66;
CONTROLS.forEach((row, i) => {
  if (!row) {
    y += 12;
    return;
  }
  rows.push(text(`help_key_${i}`, PAD, y, KEY_WIDTH, ROW, 22, GOLD, row[0]));
  rows.push(
    text(`help_action_${i}`, PAD + KEY_WIDTH, y, W - 2 * PAD - KEY_WIDTH, ROW, 22, WHITE, row[1]),
  );
  y += ROW;
});
const H = y + PAD;

const ui = [
  {
    ...text('help_hint', -260, 16, 240, 30, 22, GREY, 'H: controles', 'center'),
    anchor: 'top-right',
    visible: true,
  },
  {
    name: 'help_panel',
    alias: 'help_panel',
    type: 'image',
    x: -(W + 20),
    y: 56,
    width: W,
    height: H,
    imageParams: { texture: 'white.png', size: [W, H], color: [0.75, 0.6, 0.3, 0.9] },
    blocksInput: false,
    anchor: 'top-right',
    visible: false,
    children: [
      {
        name: 'help_bg',
        alias: 'help_bg',
        type: 'image',
        x: 3,
        y: 3,
        width: W - 6,
        height: H - 6,
        imageParams: {
          texture: 'white.png',
          size: [W - 6, H - 6],
          color: [0.05, 0.05, 0.07, 0.92],
        },
        blocksInput: false,
      },
      text('help_title', PAD, 16, W - 2 * PAD, 40, 30, GOLD, 'Controles'),
      ...rows,
    ],
  },
];

writeFileSync(
  new URL('../public/assets/ui/controls_help.json', import.meta.url),
  JSON.stringify(ui, null, 2) + '\n',
);
console.log(`controls_help.json: ${CONTROLS.filter(Boolean).length} controles`);
