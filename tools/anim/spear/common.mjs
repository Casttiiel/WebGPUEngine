// Shared spear stance. Every attack starts and ends in GUARD (the combo hub), so any attack can
// chain into any other at its cancel point.
// Coordinates: model space, Y up, facing +Z, character's left = +X. Body targets (pelvis, grip,
// look) are relative to the root; feet are in clip space (see SpearRig.solve).

/** Enemy chest, relative to the character. */
export const TARGET = [0.0, 1.3, 2.0];

/** Bladed stance, left foot forward, rear hand at the right hip, tip at the enemy's face. */
export const GUARD = {
  root: [0, 0, 0],
  pelvis: [-0.02, -0.08, -0.03],
  pelvisYPR: [-30, 6, 0],
  chestYPR: [-8, 4, 0],
  clavR: [0, 0],
  clavL: [0, 0],
  footL: { ball: [0.1, 0.015, 0.34], yaw: -12, heel: 0 },
  footR: { ball: [-0.2, 0.015, -0.3], yaw: -55, heel: 0 },
  kneeL: [0.05, 0.3, 0.6],
  kneeR: [-0.35, 0.3, 0.45],
  spear: { grip: [-0.2, 0.93, 0.06], yaw: 6, pitch: 9, front: 0.5, rollR: 30, rollL: -40 },
  elbowR: [-0.43, -0.78, -0.42],
  elbowL: [0.23, -0.98, 0.3],
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

/** Foot positions (clip space) shifted by dz from the guard ones. */
export const footL = (dz, y = 0.015) => [GUARD.footL.ball[0], y, GUARD.footL.ball[2] + dz];
export const footR = (dz, y = 0.015) => [GUARD.footR.ball[0], y, GUARD.footR.ball[2] + dz];
