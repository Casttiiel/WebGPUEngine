// Large montage of selected captured frames (from capture.mjs):
//   node tools/anim/keys.mjs name=Spear_Thrust views=side,front34 t=0,0.4,0.533,0.6
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from './rig.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const views = (args.views ?? 'side,front34').split(',');
const times = (args.t ?? '0,0.4,0.533,0.6').split(',').map(Number);
const crop = (args.crop ?? '240,60,800,600').split(',').map(Number);
const cw = Number(args.w ?? 500), ch = Math.round(cw * crop[3] / crop[2]);
const cols = Number(args.cols ?? times.length);
const rowsPerView = Math.ceil(times.length / cols);
const tiles = [];
for (const [vi, v] of views.entries()) for (const [i, t] of times.entries()) {
  const c = i % cols, r = vi * rowsPerView + Math.floor(i / cols);
  const f = path.join(ROOT, '.mcp-out/screenshots', `lab_${args.name ?? 'Spear_Thrust'}_${v}_${t.toFixed(3)}.png`);
  const img = await sharp(f).extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] }).resize(cw, ch).toBuffer();
  const label = Buffer.from(`<svg width="${cw}" height="20"><rect width="${cw}" height="20" fill="#000" opacity="0.6"/><text x="4" y="15" font-family="monospace" font-size="14" fill="#fff">${v} t=${t.toFixed(2)}</text></svg>`);
  tiles.push({ input: await sharp(img).composite([{ input: label, top: 0, left: 0 }]).toBuffer(), left: c * cw, top: r * ch });
}
const out = path.join(ROOT, `.anim-out/keys_${args.name ?? 'Spear_Thrust'}.png`);
await sharp({ create: { width: cols * cw, height: views.length * rowsPerView * ch, channels: 3, background: '#222' } }).composite(tiles).png().toFile(out);
console.log(out);
