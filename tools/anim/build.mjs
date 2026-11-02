// Builds a weapon's combo clips (tools/anim/<set>/*): contact sheets, IK check and export.
//   node tools/anim/build.mjs set=spear                 → sheets for every clip + the chained combo
//   node tools/anim/build.mjs set=spear only=sweep      → just that clip's sheet
//   node tools/anim/build.mjs set=spear tempo=heavy     → sheets with a tempo profile (spear/tempo.mjs)
//   node tools/anim/build.mjs set=greatsword --export   → public/assets/animations/<file>.gltf
//                                                        + <file>.json (hit/cancel/entry/range events),
//                                                        every tempo of the set (extra ones suffixed)
import fs from 'node:fs';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import { loadSkeleton, loadClips, Pose, ROOT, ANIM_DIR } from './rig.mjs';
import { SpearRig, SPEAR, buildTrack } from './spearRig.mjs';
import { contactSheet } from './preview.mjs';
import { writeGltfClips, FPS } from './bake.mjs';
import { TEMPOS, retime } from './spear/tempo.mjs';
import * as spear from './spear/common.mjs';
import thrust from './spear/thrust.mjs';
import sweep from './spear/sweep.mjs';
import butt from './spear/butt.mjs';
import slam from './spear/slam.mjs';
import * as gs from './greatsword/common.mjs';
import whirlwind from './greatsword/whirlwind.mjs';
import launcher from './greatsword/launcher.mjs';
import aerial from './greatsword/aerial.mjs';

const SETS = {
  spear: { file: 'spear_combat', weapon: SPEAR, guard: spear.GUARD, clips: { thrust, sweep, butt, slam }, tempos: ['agile', 'heavy'] },
  greatsword: { file: 'greatsword_combat', weapon: gs.GREATSWORD, guard: gs.GUARD, clips: { whirlwind, launcher, aerial }, tempos: ['base'] },
};

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split('=')));

const skel = loadSkeleton();
const base = new Pose(skel).sample(loadClips('universal_animations.gltf', skel).Idle_Loop, 0);
const set = SETS[args.set ?? 'spear'];
const COMBO = set.clips;
const rig = new SpearRig(skel, base, set.weapon);

function bake(clip) {
  const track = buildTrack(set.guard, clip.keys);
  const n = Math.round(track.duration * FPS);
  const frames = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.min(i / FPS, track.duration);
    const label = track.labels.find((l) => Math.abs(l.t - t) < 0.5 / FPS)?.label;
    frames.push({ t, label, ...rig.solve(track.at(t)) });
  }
  const worst = {};
  for (const f of frames)
    for (const [k, e] of Object.entries(f.err)) if (e > (worst[k]?.e ?? 0.005)) worst[k] = { e: +e.toFixed(3), t: +f.t.toFixed(2) };
  console.log(`${clip.name.padEnd(18)} ${track.duration.toFixed(2)}s  hit ${clip.events.hit}  cancel ${clip.events.cancel}  IK misses: ${JSON.stringify(worst)}`);
  return { ...clip, duration: track.duration, frames };
}

const tempoName = args.tempo ?? set.tempos[0];
const suffix = (tempo) => (tempo === set.tempos[0] ? '' : '_' + tempo[0].toUpperCase() + tempo.slice(1));
const bakeSet = (tempo) =>
  Object.entries(COMBO)
    .filter(([k]) => !args.only || args.only.split(',').includes(k))
    .map(([, c]) => {
      const r = retime(c, TEMPOS[tempo]);
      return { ...bake({ ...r, name: r.name + suffix(tempo) }), tempo };
    });
const baked = bakeSet(tempoName);

for (const c of baked) {
  await contactSheet(c.frames, path.join(ROOT, `.anim-out/${c.name}.png`), { title: `${c.name} ${c.duration.toFixed(2)}s` });
}

// The chained combo: each clip up to its cancel point; the next one starts at its entry pose
// (where it picks up from the previous hit; 0 = from the guard) where the last one left off.
if (!args.only) {
  const frames = [];
  let tOff = 0;
  const offset = vec3.create();
  const rootAt = (c, t) => (c.frames.find((f) => Math.abs(f.t - t) < 0.5 / FPS) ?? c.frames.at(-1)).root;
  baked.forEach((c, i) => {
    const last = i === baked.length - 1;
    const from = i > 0 ? c.events.entry ?? 0 : 0;
    const end = last ? c.duration : c.events.cancel;
    const clipOffset = vec3.sub(vec3.create(), offset, rootAt(c, from));
    for (const f of c.frames) {
      if (f.t < from - 1e-6 || f.t > end + 1e-6 || (frames.length && f.t === from)) continue;
      frames.push({ ...f, t: tOff + f.t - from, offset: clipOffset, label: f.label === 'hit' ? `${c.name.split('_')[1]} hit` : undefined });
    }
    vec3.add(offset, clipOffset, rootAt(c, end));
    tOff += end - from;
  });
  const sheet = path.join(ROOT, `.anim-out/${set.file}_combo${suffix(tempoName)}.png`);
  await contactSheet(frames.filter((_, i) => i % 2 === 0), sheet, { title: `combo ${tOff.toFixed(2)}s (every 2nd frame)`, cols: 14, cell: 128 });
  console.log('combo', tOff.toFixed(2) + 's, travel', offset[2].toFixed(2) + 'm');
}

if (process.argv.includes('--export')) {
  if (args.only) throw new Error('export needs every clip');
  const all = set.tempos.flatMap((t) => (t === tempoName ? baked : bakeSet(t)));
  console.log('wrote', writeGltfClips(all.map((c) => ({ name: c.name, frames: c.frames })), `${set.file}.gltf`));
  const events = { clips: all.map((c) => ({ name: c.name, tempo: c.tempo, duration: +c.duration.toFixed(4), ...c.events })) };
  fs.writeFileSync(path.join(ANIM_DIR, `${set.file}.json`), JSON.stringify(events, null, 2) + '\n');
}
