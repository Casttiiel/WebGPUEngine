// Two-handed weapon control rig (spear, greatsword…): turns high-level controls (feet, pelvis,
// torso, weapon line, hands on the shaft/handle, look target) into a full skeleton pose via
// FK + IK. The `spear` control is the weapon line for any weapon (named after the first one).
// All positions/angles are in model space: Y up, character faces +Z, its left is +X.
import { quat, vec3 } from 'gl-matrix';
import { Pose, axisAngle, basisQuat, frame, V, D2R } from './rig.mjs';

export const SPEAR = {
  length: 2.1,
  /** Rear hand distance from the butt. */
  rearGrip: 0.3,
  /** Hand nearest the butt/pommel; the other one is the front hand. */
  rearHand: 'r',
  /**
   * false: rollR/rollL are absolute (0 = fingers down). true: the fingers wrap the shaft from the
   * side away from the shoulder (wrists follow big swings on their own) and the rolls are offsets.
   */
  autoRoll: false,
};
/** Point inside the fist the shaft passes through, in hand-local space (palm faces -X / +X). */
const GRIP_OFFSET = { r: V(-0.045, 0.095, 0), l: V(0.045, 0.095, 0) };

const yawQ = (deg) => axisAngle(V(0, 1, 0), deg);
/** Yaw, then pitch (+ = nose down / lean forward) and roll (+ = lean to the character's right). */
function ypr(yaw, pitch = 0, roll = 0) {
  const y = yawQ(yaw);
  const right = vec3.transformQuat(vec3.create(), V(1, 0, 0), y);
  const fwd = vec3.transformQuat(vec3.create(), V(0, 0, 1), y);
  const q = quat.mul(quat.create(), axisAngle(right, pitch), y);
  return quat.mul(q, axisAngle(fwd, roll), q);
}
const fracQ = (q, f) => quat.slerp(quat.create(), quat.create(), q, f);

export function spearDir(yaw, pitch) {
  const p = pitch * D2R, y = yaw * D2R;
  return V(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
}

export class SpearRig {
  constructor(skel, basePose, weapon = SPEAR) {
    this.skel = skel;
    this.weapon = weapon;
    this.base = basePose;
    // Reference data from the neutral pose (before any control is applied).
    this.basePelvis = basePose.pos('pelvis');
    this.baseRot = {};
    for (const n of ['pelvis', 'foot_l', 'foot_r', 'ball_l', 'ball_r', 'Head', 'neck_01'])
      this.baseRot[n] = basePose.rot(n);
    this.footOff = {};
    for (const s of ['l', 'r']) {
      // Ankle relative to the ball of the foot, with the foot flat and neutral-yawed.
      this.footOff[s] = vec3.sub(vec3.create(), basePose.pos('foot_' + s), basePose.pos('ball_' + s));
    }
    // Head forward axis in head-local space (head looks along +Z in the neutral pose)
    const hinv = quat.invert(quat.create(), this.baseRot.Head);
    this.headFwdLocal = vec3.transformQuat(vec3.create(), V(0, 0, 1), hinv);
  }

  /**
   * c: {
   *   pelvis: [x,y,z] offset, pelvisYPR: [yaw,pitch,roll],
   *   chestYPR: [yaw,pitch,roll] (spread over spine_01..03, on top of the pelvis),
   *   footL/footR: { ball:[x,y,z], yaw, heel (deg heel lift around the ball) },
   *   kneeL/kneeR: [x,y,z] pole offset from the ankle target,
   *   spear: { grip:[x,y,z] rear-hand point on the shaft, yaw, pitch, front: distance between hands, rollR, rollL },
   *   elbowR/elbowL: [x,y,z] elbow pole, offset from the shoulder,
   *   look: [x,y,z], lookWeight, clavR/clavL: [yaw,pitch] protraction,
   *   root: [x,y,z] root motion (character origin; the engine extracts x/z and moves the entity).
   *   spin: deg — turns the whole body (and the weapon, elbow/knee poles) about the vertical
   *     axis through root + spinPivot [x,z]; the other controls are the body's own frame, so a
   *     spin attack is "the slash shape" + a spin track. spinFeet: 1 also turns the feet
   *     (airborne spins); otherwise feet stay authored in clip space (pivot steps).
   * }
   * Body targets (pelvis offset, grip, look) are relative to the root, so they travel with it;
   * feet are in clip space (where the clip started) so planted feet stay planted while it moves.
   */
  solve(c) {
    const p = this.base.clone();
    const err = {};
    const root = V(...(c.root ?? [0, 0, 0]));
    const R = (a) => vec3.add(vec3.create(), V(...a), root);
    vec3.copy(p.T[p.j('root')], root);
    p.fk();
    // Spin: rotation S about the vertical through the pivot, applied over the body's own frame
    const S = yawQ(c.spin ?? 0);
    const Sinv = quat.invert(quat.create(), S);
    const pv = c.spinPivot ?? [0, 0];
    const pivot = vec3.add(vec3.create(), root, V(pv[0], 0, pv[1]));
    const rotV = (v) => vec3.transformQuat(vec3.create(), v, S);
    const rotP = (v) => vec3.add(vec3.create(), pivot, rotV(vec3.sub(vec3.create(), v, pivot)));
    const inBody = (q) => quat.mul(quat.create(), quat.mul(quat.create(), S, q), Sinv);
    // Pelvis
    p.setWorldPos('pelvis', rotP(vec3.add(vec3.create(), this.basePelvis, R(c.pelvis))));
    p.rotateWorld('pelvis', quat.mul(quat.create(), S, ypr(...c.pelvisYPR)));
    // Spine: chest rotation relative to the pelvis, distributed bottom-up (30/35/35)
    const chest = inBody(ypr(...c.chestYPR));
    // (each world delta also carries the joints above, so the fractions add up to 1)
    p.rotateWorld('spine_01', fracQ(chest, 0.3));
    p.rotateWorld('spine_02', fracQ(chest, 0.35));
    p.rotateWorld('spine_03', fracQ(chest, 0.35));
    // Shoulder protraction (right shoulder rolls forward on the thrust)
    if (c.clavR) p.rotateWorld('clavicle_r', inBody(ypr(c.clavR[0], c.clavR[1], 0)));
    if (c.clavL) p.rotateWorld('clavicle_l', inBody(ypr(c.clavL[0], c.clavL[1], 0)));

    // Spear line
    const s = c.spear;
    const d = rotV(spearDir(s.yaw, s.pitch));
    const grip = rotP(R(s.grip));
    const butt = vec3.scaleAndAdd(vec3.create(), grip, d, -this.weapon.rearGrip);
    const tip = vec3.scaleAndAdd(vec3.create(), butt, d, this.weapon.length);
    const frontGrip = vec3.scaleAndAdd(vec3.create(), grip, d, s.front);

    // Hands: local +Z along the shaft toward the tip, fingers (+Y) wrap per roll
    const handRot = (side, roll, gripPt) => {
      // roll 0 = fingers pointing down (knuckles up); + rolls fingers toward the character's left
      // down, tilted back so the frame stays defined with the shaft vertical (overheads)
      let hint = V(0, -1, -0.3);
      if (this.weapon.autoRoll) {
        // wrist → knuckles points from the shoulder past the shaft
        hint = vec3.sub(vec3.create(), gripPt, p.pos('upperarm_' + side));
        if (vec3.length(vec3.sub(vec3.create(), hint, vec3.scale(vec3.create(), d, vec3.dot(hint, d)))) < 1e-3)
          hint = V(0, -1, -0.3);
      }
      const [z, y0] = frame(d, hint);
      const y = vec3.transformQuat(vec3.create(), y0, axisAngle(z, roll));
      const x = vec3.cross(vec3.create(), y, z);
      return basisQuat(x, y, z);
    };
    const place = (side, gripPt, roll, pole) => {
      const R = handRot(side, roll, gripPt);
      const wrist = vec3.sub(vec3.create(), gripPt, vec3.transformQuat(vec3.create(), GRIP_OFFSET[side], R));
      const elbowPole = vec3.add(vec3.create(), p.pos('upperarm_' + side), rotV(V(...pole)));
      err['arm_' + side] = p.twoBone('upperarm_' + side, 'lowerarm_' + side, 'hand_' + side, wrist, elbowPole);
      p.setWorldRot('hand_' + side, R);
    };
    const rear = this.weapon.rearHand, fr = rear === 'r' ? 'l' : 'r';
    const roll = { r: s.rollR, l: s.rollL };
    const elbow = { r: c.elbowR, l: c.elbowL };
    place(rear, grip, roll[rear], elbow[rear]);
    // The front hand slides back along the shaft when the keyed spacing is out of its reach
    // (the shaft runs through the loose front fist on a sliding thrust).
    let front = s.front;
    for (;;) {
      vec3.scaleAndAdd(frontGrip, grip, d, front);
      place(fr, frontGrip, roll[fr], elbow[fr]);
      if (err['arm_' + fr] < 0.003 || front <= 0.06) break;
      front = Math.max(0.06, front - Math.max(0.005, err['arm_' + fr] * 0.8));
    }

    // Legs
    for (const side of ['l', 'r']) {
      const f = side === 'l' ? c.footL : c.footR;
      const yq = yawQ(f.yaw + (c.spinFeet ? (c.spin ?? 0) : 0));
      const lateral = vec3.transformQuat(vec3.create(), V(1, 0, 0), yq);
      const dq = quat.mul(quat.create(), axisAngle(lateral, f.heel ?? 0), yq);
      const ball = c.spinFeet ? rotP(V(...f.ball)) : V(...f.ball);
      const ankle = vec3.add(vec3.create(), ball, vec3.transformQuat(vec3.create(), this.footOff[side], dq));
      const knee = vec3.add(vec3.create(), ankle, rotV(V(...(side === 'l' ? c.kneeL : c.kneeR))));
      err['leg_' + side] = p.twoBone('thigh_' + side, 'calf_' + side, 'foot_' + side, ankle, knee);
      p.setWorldRot('foot_' + side, quat.mul(quat.create(), dq, this.baseRot['foot_' + side]));
      // Toes stay flat on the ground while the heel lifts
      p.setWorldRot('ball_' + side, quat.mul(quat.create(), yq, this.baseRot['ball_' + side]));
    }

    // Head: look at target (neck takes 40%, head the rest)
    const look = c.look ? R(c.look) : null;
    if (look) {
      // the head gives up on the target when the body has turned away from it (spins)
      const fwd0 = vec3.normalize(vec3.create(), vec3.transformQuat(vec3.create(), this.headFwdLocal, p.rot('Head')));
      const to0 = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), look, p.pos('Head')));
      const away = Math.acos(Math.min(1, Math.max(-1, vec3.dot(fwd0, to0)))) / D2R;
      const w = (c.lookWeight ?? 1) * (1 - Math.min(1, Math.max(0, (away - 70) / 40)));
      for (const [n, f] of [['neck_01', 0.4 * w], ['Head', 1.0 * w]]) {
        const fwd = vec3.transformQuat(vec3.create(), this.headFwdLocal, p.rot('Head'));
        const to = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), look, p.pos('Head')));
        p.rotateWorld(n, fracQ(quat.rotationTo(quat.create(), vec3.normalize(fwd, fwd), to), f));
      }
    }
    return { pose: p, err, root, spear: { butt, tip, grip, frontGrip }, target: look };
  }
}

// ── keyframe tracks ───────────────────────────────────────────────────────────
/** Flattens a control object into path → number for interpolation. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (out[`${key}.${i}`] = x));
    else if (typeof v === 'object' && v !== null) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function unflatten(flat) {
  const root = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split('.');
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const isIdx = /^\d+$/.test(parts[i + 1]);
      o = o[parts[i]] ??= isIdx ? [] : {};
    }
    o[parts[parts.length - 1]] = v;
  }
  return root;
}
const deepMerge = (a, b) => {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
};

/** Segment easings: 'in' accelerates into the key (strikes), 'out' leaves fast and settles. */
const EASE = {
  linear: (u) => u,
  in: (u) => u * u * u,
  in2: (u) => u * u,
  out: (u) => 1 - (1 - u) ** 3,
  out2: (u) => 1 - (1 - u) ** 2,
  inout: (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2),
};

/** Monotone cubic (Fritsch–Carlson): smooth, no overshoot beyond keyed values, flat on holds. */
function monotone(ts, ys, t) {
  const n = ts.length;
  if (t <= ts[0]) return ys[0];
  if (t >= ts[n - 1]) return ys[n - 1];
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(ts[i + 1] - ts[i]); m.push((ys[i + 1] - ys[i]) / dx[i]); }
  const tan = [m[0]];
  for (let i = 1; i < n - 1; i++) tan.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  tan.push(m[n - 2]);
  let k = 0;
  while (t > ts[k + 1]) k++;
  const h = dx[k], u = (t - ts[k]) / h;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return h00 * ys[k] + h10 * h * tan[k] + h01 * ys[k + 1] + h11 * h * tan[k + 1];
}

/**
 * keys: [{ t, label?, ...partialControls }] — each key inherits unspecified controls from the
 * previous one. Endpoint tangents are flattened (first/last keys are holds), so a looping clip
 * whose first and last keys match has no velocity pop at the seam.
 */
export function buildTrack(base, keys) {
  const full = [];
  let cur = base;
  for (const k of keys) {
    const { t, label, ease, phase: _phase, ...ctrl } = k;
    cur = deepMerge(cur, ctrl);
    full.push({ t, label, flat: flatten(cur) });
  }
  const ts = full.map((k) => k.t);
  const paths = Object.keys(full[0].flat);
  for (const k of full) {
    const extra = Object.keys(k.flat).filter((p) => !(p in full[0].flat));
    if (extra.length) throw new Error(`key t=${k.t} adds controls the first key lacks: ${extra.join(', ')}`);
  }
  return {
    duration: ts[ts.length - 1],
    labels: full.filter((k) => k.label).map((k) => ({ t: k.t, label: k.label })),
    at(t) {
      const flat = {};
      // A key's `ease` replaces the spline on the segment that ends at that key
      let k = 0;
      while (k < ts.length - 2 && t >= ts[k + 1]) k++;
      const ease = EASE[keys[k + 1]?.ease];
      const u = Math.min(1, Math.max(0, (t - ts[k]) / (ts[k + 1] - ts[k])));
      for (const p of paths) {
        flat[p] = ease
          ? full[k].flat[p] + (full[k + 1].flat[p] - full[k].flat[p]) * ease(u)
          : monotone(ts, full.map((kk) => kk.flat[p]), t);
      }
      return unflatten(flat);
    },
  };
}
