// In-engine review in the anim_lab scene through the MCP CLI; the shots are montaged into one
// contact sheet (.anim-out/lab_<name>.png) and kept for keys.mjs.
//   node tools/anim/capture.mjs clip=Spear_Thrust [step=2] [views=side,front34,back34]
//       exact clip times, frozen (TSR settled), root motion shown as mesh travel
//   node tools/anim/capture.mjs live=Spear_Combo [frames=80] [views=side]
//       real-time playback at 30 fps through ?animLoop (crossfades, root motion, trails)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { ROOT, ANIM_DIR } from './rig.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const live = args.live;
const clip = args.clip ?? 'Spear_Thrust';
const every = Number(args.step ?? 2) / 30;
const zc = Number(args.zc ?? (live ? 1.3 : 1.0)); // where the camera looks along the travel
const ty = Number(args.ty ?? 1.0); // camera target height (raise it for jumps)
const VIEWS = {
  side: { eye: [4.4, ty + 0.3, zc], target: [0, ty, zc] },
  front34: { eye: [-2.4, ty + 0.6, zc + 3.0], target: [0, ty, zc - 0.3] },
  back34: { eye: [-2.6, ty + 0.7, zc - 3.0], target: [0, ty, zc - 0.2] },
  top: { eye: [0.01, 6.0, zc], target: [0, 0, zc] },
  high: { eye: [-2.2, ty + 2.4, zc - 2.0], target: [0, ty - 0.2, zc + 0.4] },
};
const views = (args.views ?? (live ? 'side' : 'side,front34,back34')).split(',');
const name = live ?? clip;

const setCam = (v) =>
  `Engine.getEntities().getEntityByName('PlayerCamera').getComponent('camera').getCamera().lookAt(new Float32Array(${JSON.stringify(v.eye)}), new Float32Array(${JSON.stringify(v.target)}));`;

const shots = [];
const calls = [];
if (live) {
  const frames = Number(args.frames ?? 80);
  calls.push(['launch', { scene: 'anim_lab.json', params: { animLoop: live }, headless: false }]);
  for (const view of views) {
    // restart the sequence from its first step, then advance one 30 fps frame per shot
    calls.push(['pause', {}]);
    calls.push(['eval', { code: `const s = Engine.getEntities().getEntityByName('SpearFighter').getComponent('anim_sequence'); s.stepIndex = -1; s.waiting = 0; ${setCam(VIEWS[view])} return 1;` }]);
    for (let i = 0; i < frames; i++) {
      const shot = `lab_${name}_${view}_${(i / 30).toFixed(3)}`;
      // simulate at 30·sub fps (trails push one node per simulated frame), one shot per 1/30 s
      const sub = Number(args.sub ?? 2);
      calls.push(['step', { frames: sub, fixedDelta: 1 / (30 * sub) }]);
      calls.push(['eval', { code: setCam(VIEWS[view]) + ' return 1;' }]);
      calls.push(['screenshot', { hideDebugUi: true, saveAs: shot }]);
      shots.push({ view, t: i / 30, file: path.join(ROOT, '.mcp-out/screenshots', shot + '.png') });
    }
  }
} else {
  // the clip's set (Spear_Thrust → spear_combat.json); ?animLoop gives the lab fighter its weapon
  const events = JSON.parse(fs.readFileSync(path.join(ANIM_DIR, `${clip.split('_')[0].toLowerCase()}_combat.json`), 'utf8'));
  const duration = Number(args.duration ?? events.clips.find((c) => c.name === clip)?.duration ?? 1);
  calls.push(['launch', { scene: 'anim_lab.json', params: { animLoop: clip }, headless: false }]);
  calls.push(['set_time_scale', { scale: 1, fixedDelta: 0.00001 }]);
  // the preview's sequence would fight the frame-exact playback below
  calls.push(['eval', { code: `const s = Engine.getEntities().getEntityByName('SpearFighter').getComponent('anim_sequence'); if (s) s.steps = []; return 1;` }]);
  for (const view of views) {
    for (let t = 0; t <= duration + 1e-6; t += every) {
      const shot = `lab_${name}_${view}_${t.toFixed(3)}`;
      calls.push(['eval', { code: `const a = Engine.getEntities().getEntityByName('SpearFighter').getComponent('animator'); a.playClip('${clip}', { blendTime: 0 }); a.playbackTime = ${t}; ${setCam(VIEWS[view])} return a.playbackTime;` }]);
      // a few frames so TSR history settles on the frozen pose
      calls.push(['step', { frames: 8 }]);
      calls.push(['screenshot', { hideDebugUi: true, saveAs: shot }]);
      shots.push({ view, t, file: path.join(ROOT, '.mcp-out/screenshots', shot + '.png') });
    }
  }
}
calls.push(['close', {}]);
const callsFile = path.join(ROOT, '.anim-out/capture_calls.json');
fs.writeFileSync(callsFile, JSON.stringify(calls));
const log = execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'tools/mcp/call.ts'), '@' + callsFile], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const errs = log.split('\n').filter((l) => /\[ERROR\]|Error/.test(l));
if (errs.length) console.log(errs.slice(0, 10).join('\n'));

// Montage: one row block per view, crop the middle of each 1280x720 shot
const cols = Number(args.cols ?? 11), cw = 330, ch = 240;
const perView = shots.filter((s) => s.view === views[0]).length;
const rowsPerView = Math.ceil(perView / cols);
const W = cols * cw, H = views.length * rowsPerView * ch;
const comps = [];
for (const [vi, view] of views.entries()) {
  shots.filter((s) => s.view === view).forEach((s, i) => {
    if (!fs.existsSync(s.file)) return;
    comps.push({ s, left: (i % cols) * cw, top: (vi * rowsPerView + Math.floor(i / cols)) * ch });
  });
}
const tiles = await Promise.all(comps.map(async ({ s, left, top }) => {
  const img = await sharp(s.file).extract({ left: 200, top: 40, width: 880, height: 640 }).resize(cw, ch).toBuffer();
  const label = Buffer.from(`<svg width="${cw}" height="18"><rect width="${cw}" height="18" fill="#000" opacity="0.5"/><text x="4" y="13" font-family="monospace" font-size="12" fill="#fff">${s.view} t=${s.t.toFixed(2)} f${Math.round(s.t * 30)}</text></svg>`);
  const tile = await sharp(img).composite([{ input: label, top: 0, left: 0 }]).toBuffer();
  return { input: tile, left, top };
}));
const out = path.join(ROOT, `.anim-out/lab_${name}.png`);
await sharp({ create: { width: W, height: H, channels: 3, background: '#222' } }).composite(tiles).png().toFile(out);
console.log('montage', out, tiles.length, 'tiles');
