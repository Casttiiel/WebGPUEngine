// Greatsword: a heavy two-hander. Left hand on the pommel end, right hand under the guard.
// Heavier than the spear in every phase — longer loads, 4–5 frame strikes, follow-throughs that
// drag the body, effortful recoveries — and each hit flows out of the previous one's end pose
// (`entry` event) instead of going back to the guard, so the momentum carries the combo.
// Coordinates as in spear/common.mjs (model space, Y up, facing +Z, left = +X; body targets
// relative to the root, feet in clip space).

export const GREATSWORD = {
  length: 1.65,
  /** Left hand distance from the pommel end. */
  rearGrip: 0.06,
  rearHand: 'l',
  autoRoll: true,
};

/** Enemy chest, relative to the character. */
export const TARGET = [0.0, 1.3, 1.9];

/** Low two-handed guard: hands in front of the right hip, blade angled up at the enemy. */
export const GUARD = {
  root: [0, 0, 0],
  pelvis: [-0.02, -0.12, -0.04],
  pelvisYPR: [-35, 8, 0],
  chestYPR: [-10, 6, 0],
  clavR: [0, 0],
  clavL: [0, 0],
  footL: { ball: [0.12, 0.015, 0.38], yaw: -15, heel: 0 },
  footR: { ball: [-0.24, 0.015, -0.32], yaw: -60, heel: 0 },
  kneeL: [0.1, 0.3, 0.6],
  kneeR: [-0.4, 0.3, 0.45],
  spear: { grip: [-0.06, 0.98, 0.2], yaw: 8, pitch: 35, front: 0.13, rollR: 0, rollL: 0 },
  elbowR: [-0.3, -0.85, 0.1],
  elbowL: [0.25, -0.85, 0.2],
  look: TARGET,
  lookWeight: 0.8,
};

/** The guard after travelling `dz` forward: root and planted feet moved with it. */
export function guardAt(dz) {
  const g = structuredClone(GUARD);
  g.root = [0, 0, dz];
  g.footL.ball[2] += dz;
  g.footR.ball[2] += dz;
  return g;
}

export const footL = (dz, y = 0.015) => [GUARD.footL.ball[0], y, GUARD.footL.ball[2] + dz];
export const footR = (dz, y = 0.015) => [GUARD.footR.ball[0], y, GUARD.footR.ball[2] + dz];
