// Samples an authored animation and writes it as a glTF clip that AnimatorComponent's
// extraAnimations loader understands (channels are matched to joints by node name).
import fs from 'node:fs';
import path from 'node:path';
import { ANIM_DIR } from './rig.mjs';

export const FPS = 30;

/** clips: [{ name, frames: [{ t, pose }] covering [0, duration] at FPS }] → one glTF. */
export function writeGltfClips(clips, file) {
  const skel = clips[0].frames[0].pose.skel;
  const chunks = [];
  let offset = 0;
  const bufferViews = [], accessors = [];
  const push = (arr, type, minmax) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
    const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type };
    if (minmax) Object.assign(acc, minmax);
    accessors.push(acc);
    return accessors.length - 1;
  };
  const animations = clips.map(({ name, frames }) => {
    const n = frames.length;
    const channels = [], samplers = [];
    const times = new Float32Array(frames.map((f) => f.t));
    const timeAcc = push(times, 'SCALAR', { min: [times[0]], max: [times[n - 1]] });
    skel.names.forEach((jn, ji) => {
      const rot = new Float32Array(n * 4);
      frames.forEach((f, k) => {
        const q = f.pose.R[ji];
        // keep quaternion hemisphere continuous so LINEAR/slerp never takes the long way
        if (k > 0) {
          const prev = rot.subarray((k - 1) * 4, k * 4);
          const dot = prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3];
          rot.set(dot < 0 ? q.map((v) => -v) : q, k * 4);
        } else rot.set(q, 0);
      });
      samplers.push({ input: timeAcc, output: push(rot, 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: ji, path: 'rotation' } });
      // root carries the root motion, pelvis the body offset
      if (jn === 'pelvis' || jn === 'root') {
        const tr = new Float32Array(n * 3);
        frames.forEach((f, k) => tr.set(f.pose.T[ji], k * 3));
        samplers.push({ input: timeAcc, output: push(tr, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: ji, path: 'translation' } });
      }
    });
    return { name, channels, samplers };
  });
  const bin = Buffer.concat(chunks);
  const binName = path.basename(file).replace(/\.gltf$/, '.bin');
  const gltf = {
    asset: { version: '2.0', generator: 'tools/anim (procedural spear rig)' },
    nodes: skel.names.map((name) => ({ name })),
    animations,
    buffers: [{ uri: binName, byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  const out = path.join(ANIM_DIR, file);
  fs.writeFileSync(out, JSON.stringify(gltf));
  fs.writeFileSync(path.join(ANIM_DIR, binName), bin);
  return out;
}
