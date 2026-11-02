// 1 — Whirlwind: the sword is wound back on the right with the back to the enemy; the hips let go
// first, the blade crosses the front (hit 1) and doesn't stop — the whole body turns a full 360°
// pivoting on the left foot, the right foot taking two big steps round it, the blade held out
// at waist height lagging behind the chest, crossing the front again (hit 2). Momentum carries
// it 40° further before it holds. Ends turned left with the blade out on the left.
import { guardAt, footL, footR, GUARD } from './common.mjs';

const TRAVEL = 0.3;
/** The left foot after the first step: the pivot of the spin (root-relative while root = TRAVEL). */
const PIVOT = [GUARD.footL.ball[0], GUARD.footL.ball[2]];

/** The right foot walked round the pivot foot by `deg` (positive = turning left). */
function rightAround(deg, lift = 0.015) {
  const a = (deg * Math.PI) / 180;
  const [lx, lz] = [GUARD.footL.ball[0], GUARD.footL.ball[2] + TRAVEL];
  const vx = GUARD.footR.ball[0] - GUARD.footL.ball[0], vz = GUARD.footR.ball[2] - GUARD.footL.ball[2];
  return { ball: [lx + vx * Math.cos(a) + vz * Math.sin(a), lift, lz - vx * Math.sin(a) + vz * Math.cos(a)], yaw: GUARD.footR.yaw + deg };
}
const leftPivot = (deg, heel = 15) => ({ ball: footL(TRAVEL), yaw: GUARD.footL.yaw + deg, heel });

/** The body's own pose while spinning: blade out at waist height, lagging behind the chest. */
const SPIN_BODY = {
  pelvis: [0.0, -0.2, 0.0],
  pelvisYPR: [15, 10, 0],
  chestYPR: [22, 6, -10],
  clavR: [10, 0],
  clavL: [-6, 0],
  spear: { grip: [0.02, 1.1, 0.42], yaw: 4, pitch: -2 },
  elbowR: [-0.3, -0.8, 0.2],
  elbowL: [0.3, -0.8, 0.2],
  kneeL: [0.15, 0.3, 0.7],
};

/** Follow-through pose (also the launcher's entry). */
export const SPIN_END = { ...SPIN_BODY, pelvis: [0.0, -0.23, 0.0], chestYPR: [34, 12, -12], spear: { grip: [0.15, 1.02, 0.38], yaw: 30, pitch: -14 } };

export default {
  name: 'Greatsword_Whirlwind',
  // two hits in one spin; range: distance to the target (m) the hits are authored for
  events: { hit: 0.46, hit2: 0.74, cancel: 0.92, range: 2.0 },
  keys: [
    { t: 0, label: 'guard', spin: 0, spinPivot: PIVOT },
    // Wind: blade back on the right, back turned to the enemy, weight on the rear leg
    {
      t: 0.26,
      phase: 'antic',
      label: 'wind',
      pelvis: [-0.05, -0.18, -0.1],
      pelvisYPR: [-65, 6, -6],
      chestYPR: [-42, 0, 8],
      spear: { grip: [-0.3, 1.12, -0.1], yaw: -150, pitch: 6 },
      elbowR: [-0.3, -0.75, -0.3],
      elbowL: [0.1, -0.8, 0.35],
      footL: { heel: 10 },
      kneeR: [-0.45, 0.3, 0.4],
    },
    { t: 0.32, phase: 'antic', spear: { yaw: -156, grip: [-0.31, 1.13, -0.12] }, chestYPR: [-45, 0, 8] },
    // Release: hips go first, step onto the pivot foot
    {
      t: 0.4,
      phase: 'strike',
      label: 'release',
      ease: 'in2',
      root: [0, 0, 0.2],
      pelvis: [-0.02, -0.19, -0.04],
      pelvisYPR: [-20, 10, 0],
      chestYPR: [-26, 4, 4],
      spear: { grip: [-0.35, 1.1, 0.12], yaw: -80, pitch: 2 },
      footL: { ball: footL(0.2, 0.09), heel: -5 },
      footR: { heel: 15 },
    },
    // Hit 1: blade crosses the front, the spin begins
    { t: 0.46, phase: 'strike', label: 'hit', ease: 'linear', root: [0, 0, TRAVEL], ...SPIN_BODY, spin: 0, footL: leftPivot(0, 0), footR: { heel: 30 }, lookWeight: 0.8 },
    // The turn: right foot steps round the pivot (in the air between plants)
    { t: 0.52, phase: 'strike', spin: 90, footL: leftPivot(90), footR: rightAround(90, 0.12) },
    { t: 0.59, phase: 'strike', label: 'back', spin: 180, footR: rightAround(180) },
    { t: 0.66, phase: 'strike', spin: 270, footR: rightAround(270, 0.12) },
    // Hit 2: round to the front again
    { t: 0.74, phase: 'strike', label: 'hit 2', spin: 360, footL: leftPivot(360, 0), footR: rightAround(360) },
    // Momentum carries it on
    { t: 0.82, phase: 'strike', label: 'follow', ease: 'out2', spin: 400, ...SPIN_END, footL: leftPivot(400, 10), footR: { ...rightAround(380), heel: 25 } },
    { t: 0.92, phase: 'hold', label: 'hold', spin: 404, pelvis: [0.0, -0.235, 0.0] },
    // Recovery: unwind the extra turn back into the guard
    {
      t: 1.16,
      phase: 'recover',
      label: 'recover',
      ease: 'out',
      spin: 360,
      pelvis: [-0.03, -0.1, -0.04],
      pelvisYPR: [-32, 7, 0],
      chestYPR: [-9, 5, 0],
      clavR: [0, 0],
      clavL: [0, 0],
      spear: { grip: [-0.06, 0.98, 0.19], yaw: 10, pitch: 30 },
      elbowR: [-0.3, -0.85, 0.1],
      elbowL: [0.25, -0.85, 0.2],
      footL: leftPivot(360, 0),
      footR: { ...rightAround(360, 0.06), heel: 6 },
      kneeL: [0.1, 0.3, 0.6],
    },
    { t: 1.26, phase: 'recover', footR: { ...rightAround(360), heel: 0 }, spear: { pitch: 37 } },
    {
      t: 1.38,
      phase: 'recover',
      label: 'guard',
      ...guardAt(TRAVEL),
      spin: 360,
      footL: { ...guardAt(TRAVEL).footL, yaw: GUARD.footL.yaw + 360 },
      footR: { ...guardAt(TRAVEL).footR, yaw: GUARD.footR.yaw + 360 },
    },
  ],
};
