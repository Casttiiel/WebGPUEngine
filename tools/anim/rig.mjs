// Authoring rig: loads the character skeleton + reference clips from glTF and gives
// model-space posing tools (world rotations, two-bone IK, aim) over a local-TRS pose.
// Model space = the skinned mesh's space (Y up, character faces +Z), same as
// AnimatorComponent.globalMats.
import fs from 'node:fs';
import path from 'node:path';
import { mat4, quat, vec3 } from 'gl-matrix';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
export const ANIM_DIR = path.join(ROOT, 'public/assets/animations');
const CHARACTER = path.join(ROOT, 'public/assets/meshes/character/character.gltf');

function readGltf(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const buffers = (json.buffers ?? []).map((b) => {
    if (!b.uri) return Buffer.alloc(0);
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.split(',')[1], 'base64');
    return fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(b.uri)));
  });
  const accessor = (i) => {
    const acc = json.accessors[i];
    const bv = json.bufferViews[acc.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
    const buf = buffers[bv.buffer];
    const off = buf.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    if (acc.componentType !== 5126) throw new Error('only float accessors supported');
    return new Float32Array(buf.buffer.slice(off, off + acc.count * n * 4));
  };
  return { json, accessor };
}

export function loadSkeleton() {
  const { json, accessor } = readGltf(CHARACTER);
  const skin = json.skins[0];
  const joints = skin.joints;
  const names = joints.map((j) => json.nodes[j].name);
  const parents = joints.map((j) => {
    const p = json.nodes.findIndex((n) => n.children?.includes(j));
    return joints.indexOf(p);
  });
  const bindT = [], bindR = [], bindS = [];
  for (const j of joints) {
    const n = json.nodes[j];
    bindT.push(vec3.clone(n.translation ?? [0, 0, 0]));
    bindR.push(quat.clone(n.rotation ?? [0, 0, 0, 1]));
    bindS.push(vec3.clone(n.scale ?? [1, 1, 1]));
  }
  // Parents always precede children in this skin, but sort anyway.
  const order = [];
  const visit = (i) => { if (order.includes(i)) return; if (parents[i] >= 0) visit(parents[i]); order.push(i); };
  names.forEach((_, i) => visit(i));
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  return { names, parents, bindT, bindR, bindS, order, idx, ibm: accessor(skin.inverseBindMatrices) };
}

export function loadClips(file, skel) {
  const { json, accessor } = readGltf(path.join(ANIM_DIR, file));
  const clips = {};
  for (const a of json.animations) {
    const channels = [];
    let duration = 0;
    for (const ch of a.channels) {
      const name = json.nodes[ch.target.node]?.name;
      const ji = skel.idx[name];
      if (ji === undefined) continue;
      const s = a.samplers[ch.sampler];
      const times = accessor(s.input);
      duration = Math.max(duration, times[times.length - 1]);
      channels.push({ ji, path: ch.target.path, times, values: accessor(s.output) });
    }
    clips[a.name] = { name: a.name, duration, channels };
  }
  return clips;
}

export class Pose {
  constructor(skel) {
    this.skel = skel;
    this.T = skel.bindT.map((v) => vec3.clone(v));
    this.R = skel.bindR.map((q) => quat.clone(q));
    this.S = skel.bindS.map((v) => vec3.clone(v));
    this.G = skel.names.map(() => mat4.create());
    this.fk();
  }
  clone() {
    const p = new Pose(this.skel);
    this.T.forEach((v, i) => vec3.copy(p.T[i], v));
    this.R.forEach((q, i) => quat.copy(p.R[i], q));
    p.fk();
    return p;
  }
  sample(clip, t) {
    for (const ch of clip.channels) {
      const { times, values } = ch;
      let k = 0;
      while (k < times.length - 2 && times[k + 1] <= t) k++;
      const a = times.length > 1 ? Math.min(1, Math.max(0, (t - times[k]) / (times[k + 1] - times[k]))) : 0;
      const k1 = Math.min(k + 1, times.length - 1);
      if (ch.path === 'rotation') {
        const q0 = values.subarray(k * 4, k * 4 + 4), q1 = values.subarray(k1 * 4, k1 * 4 + 4);
        quat.slerp(this.R[ch.ji], q0, q1, a);
      } else if (ch.path === 'translation') {
        vec3.lerp(this.T[ch.ji], values.subarray(k * 3, k * 3 + 3), values.subarray(k1 * 3, k1 * 3 + 3), a);
      }
    }
    this.fk();
    return this;
  }
  fk(from = -1) {
    const { order, parents } = this.skel;
    const local = mat4.create();
    for (const i of order) {
      if (from >= 0 && !this.isDescendant(i, from)) continue;
      mat4.fromRotationTranslationScale(local, this.R[i], this.T[i], this.S[i]);
      const p = parents[i];
      if (p < 0) mat4.copy(this.G[i], local);
      else mat4.mul(this.G[i], this.G[p], local);
    }
  }
  isDescendant(i, ancestor) {
    for (let k = i; k >= 0; k = this.skel.parents[k]) if (k === ancestor) return true;
    return false;
  }
  j(name) {
    const i = this.skel.idx[name];
    if (i === undefined) throw new Error('no joint ' + name);
    return i;
  }
  pos(name) { return mat4.getTranslation(vec3.create(), this.G[this.j(name)]); }
  rot(name) { const q = mat4.getRotation(quat.create(), this.G[this.j(name)]); return quat.normalize(q, q); }
  /** World (model-space) rotation of the joint's frame, ignoring scale. */
  /** Pre-multiply a model-space rotation onto a joint (rotates it and its subtree about the joint). */
  rotateWorld(name, q) {
    const i = this.j(name);
    const p = this.skel.parents[i];
    const pr = p < 0 ? quat.create() : quat.normalize(quat.create(), mat4.getRotation(quat.create(), this.G[p]));
    const g = quat.mul(quat.create(), pr, this.R[i]);
    quat.mul(g, q, g);
    this.setWorldRot(name, g);
  }
  setWorldRot(name, g) {
    const i = this.j(name);
    const p = this.skel.parents[i];
    const pr = p < 0 ? quat.create() : quat.normalize(quat.create(), mat4.getRotation(quat.create(), this.G[p]));
    const inv = quat.invert(quat.create(), pr);
    quat.normalize(this.R[i], quat.mul(this.R[i], inv, g));
    this.fk(i);
  }
  /** Moves a joint so its model-space position becomes `worldPos` (translation in parent space). */
  setWorldPos(name, worldPos) {
    const i = this.j(name);
    const p = this.skel.parents[i];
    const inv = mat4.invert(mat4.create(), this.G[p]);
    vec3.transformMat4(this.T[i], worldPos, inv);
    this.fk(i);
  }
  /** Rotate `name` (minimal arc) so that the direction joint→child points along `dir`. */
  aim(name, childName, dir) {
    const a = this.pos(name), b = this.pos(childName);
    const cur = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), b, a));
    const want = vec3.normalize(vec3.create(), dir);
    this.rotateWorld(name, quat.rotationTo(quat.create(), cur, want));
  }
  /**
   * Two-bone IK: places `tip` at `target`, elbow/knee bending toward `pole` (a model-space point).
   */
  twoBone(rootN, midN, tipN, target, pole) {
    const a = this.pos(rootN), b = this.pos(midN), c = this.pos(tipN);
    const l1 = vec3.dist(a, b), l2 = vec3.dist(b, c);
    const toT = vec3.sub(vec3.create(), target, a);
    let d = vec3.length(toT);
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
    const dirT = vec3.normalize(vec3.create(), toT);
    // Bend plane from the pole
    const toP = vec3.sub(vec3.create(), pole, a);
    const perp = vec3.scaleAndAdd(vec3.create(), toP, dirT, -vec3.dot(toP, dirT));
    vec3.normalize(perp, perp);
    const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    const ang = Math.acos(Math.min(1, Math.max(-1, cosA)));
    const elbow = vec3.create();
    vec3.scaleAndAdd(elbow, a, dirT, Math.cos(ang) * l1);
    vec3.scaleAndAdd(elbow, elbow, perp, Math.sin(ang) * l1);
    this.aim(rootN, midN, vec3.sub(vec3.create(), elbow, a));
    const reach = vec3.add(vec3.create(), a, vec3.scale(vec3.create(), dirT, d));
    this.aim(midN, tipN, vec3.sub(vec3.create(), reach, this.pos(midN)));
    return vec3.dist(this.pos(tipN), target); // > 0 when the target is out of reach
  }
}

// ── math helpers ───────────────────────────────────────────────────────────────
export const D2R = Math.PI / 180;
export const axisAngle = (axis, deg) => quat.setAxisAngle(quat.create(), vec3.normalize(vec3.create(), axis), deg * D2R);
export const V = (x, y, z) => vec3.fromValues(x, y, z);
/** Rotation whose +Y maps to `fwd`... generic: build a quat from an orthonormal basis (x, y, z columns). */
export function basisQuat(x, y, z) {
  const m = mat4.fromValues(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1);
  return quat.normalize(quat.create(), mat4.getRotation(quat.create(), m));
}
/** Orthonormal frame with `primary` exact and `hint` projected. Returns [primary, hintOrtho, cross]. */
export function frame(primary, hint) {
  const p = vec3.normalize(vec3.create(), primary);
  const h = vec3.scaleAndAdd(vec3.create(), hint, p, -vec3.dot(hint, p));
  vec3.normalize(h, h);
  const c = vec3.cross(vec3.create(), p, h);
  return [p, h, c];
}
