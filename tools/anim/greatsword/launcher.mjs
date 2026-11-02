// 2 — Launcher: out of the whirlwind (blade out on the left — the entry pose when chained) the
// sword is dragged low behind on the left, tip scraping the ground, the body crouched over it;
// then it rips up in a vertical arc through the front and over the head while the fighter hops
// off the ground with it. Lands with the sword held high — the aerial spin's wind-up.
import { guardAt, footL, footR } from './common.mjs';
import { SPIN_END } from './whirlwind.mjs';

const TRAVEL = 0.35;
const HOP = 0.4;

/** Landing pose with the sword held high (also the aerial spin's entry). */
export const HIGH_LANDED = {
  pelvis: [-0.02, -0.16, -0.03],
  pelvisYPR: [-22, 4, 0],
  chestYPR: [-6, -10, 2],
  spear: { grip: [-0.06, 1.62, 0.12], yaw: -4, pitch: 98 },
  elbowR: [-0.5, -0.1, 0.15],
  elbowL: [0.5, -0.1, 0.2],
};

export default {
  name: 'Greatsword_Launcher',
  // range: distance to the target (m) the hit is authored for; entry: pose a chained hit starts from
  events: { hit: 0.5, cancel: 0.86, entry: 0.2, range: 1.7 },
  keys: [
    { t: 0, label: 'guard' },
    // (standalone) swing the blade out to the left — chained hits start here
    { t: 0.2, phase: 'antic', label: 'out', ...SPIN_END },
    // Drag: blade low behind on the left, tip on the ground, crouched over it
    {
      t: 0.34,
      phase: 'antic',
      label: 'drag',
      pelvis: [-0.02, -0.3, -0.06],
      pelvisYPR: [30, 18, 4],
      chestYPR: [38, 26, -10],
      clavR: [14, 0],
      clavL: [0, 0],
      spear: { grip: [0.26, 0.78, -0.08], yaw: 150, pitch: -28 },
      elbowR: [-0.05, -0.85, 0.3],
      elbowL: [0.45, -0.75, -0.1],
      kneeR: [-0.4, 0.3, 0.55],
    },
    { t: 0.4, phase: 'antic', pelvis: [-0.02, -0.32, -0.07], spear: { grip: [0.27, 0.76, -0.1], yaw: 153 } },
    // Rip: the blade swings under and forward, body driving up
    {
      t: 0.46,
      phase: 'strike',
      label: 'rip',
      ease: 'in2',
      root: [0, 0, 0.15],
      pelvis: [-0.01, -0.2, -0.02],
      pelvisYPR: [8, 14, 0],
      chestYPR: [12, 12, -4],
      spear: { grip: [0.08, 0.86, 0.32], yaw: 40, pitch: -62 },
      elbowR: [-0.2, -0.85, 0.3],
      elbowL: [0.35, -0.8, 0.2],
      footL: { ball: footL(0.15, 0.06), heel: -5 },
      footR: { heel: 20 },
    },
    // Hit: rising through the enemy, feet leaving the ground
    {
      t: 0.5,
      phase: 'strike',
      label: 'hit',
      ease: 'linear',
      root: [0, 0, 0.28],
      pelvis: [-0.01, 0.05, 0.0],
      pelvisYPR: [-6, 4, 0],
      chestYPR: [-2, -6, 0],
      clavR: [8, 0],
      spear: { grip: [-0.04, 1.22, 0.34], yaw: 4, pitch: 25 },
      elbowR: [-0.35, -0.6, 0.2],
      elbowL: [0.35, -0.6, 0.2],
      footL: { ball: footL(0.28, 0.06), heel: 30 },
      footR: { ball: footR(0.2, 0.06), heel: 40 },
    },
    // Apex of the hop: sword over the head, body stretched, legs trailing
    {
      t: 0.62,
      phase: 'strike',
      label: 'apex',
      ease: 'out2',
      root: [0, 0, TRAVEL],
      pelvis: [-0.02, HOP, -0.02],
      pelvisYPR: [-18, -4, 0],
      chestYPR: [-6, -16, 2],
      clavR: [0, 0],
      spear: { grip: [-0.06, 1.75 + HOP, 0.1], yaw: -4, pitch: 100 },
      elbowR: [-0.5, -0.1, 0.15],
      elbowL: [0.5, -0.1, 0.2],
      footL: { ball: footL(TRAVEL, HOP + 0.06), heel: 25 },
      footR: { ball: footR(TRAVEL - 0.05, HOP + 0.05), heel: 35 },
    },
    // Land, sword still high
    {
      t: 0.74,
      phase: 'hold',
      label: 'land',
      ease: 'in2',
      ...HIGH_LANDED,
      footL: { ball: footL(TRAVEL), heel: 0 },
      footR: { ball: footR(TRAVEL), heel: 0 },
    },
    { t: 0.86, phase: 'hold', label: 'hold', pelvis: [-0.02, -0.15, -0.03] },
    // Recovery: bring the sword down to the guard
    {
      t: 1.08,
      phase: 'recover',
      label: 'lower',
      ease: 'out',
      pelvis: [-0.03, -0.1, -0.04],
      pelvisYPR: [-32, 7, 0],
      chestYPR: [-9, 5, 0],
      spear: { grip: [-0.06, 0.98, 0.19], yaw: 10, pitch: 30 },
      elbowR: [-0.3, -0.85, 0.1],
      elbowL: [0.25, -0.85, 0.2],
    },
    { t: 1.2, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
