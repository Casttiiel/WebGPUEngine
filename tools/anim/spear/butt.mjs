// 3 — Butt strike: big counter-wind (tip up and out to the right, butt low behind), a long step
// in, and the butt end rips upward through the enemy's chin while the tip drops behind on the
// left; the follow-through leans the body back with the arms high. Exaggerated on purpose.
import { guardAt, footL, footR } from './common.mjs';

const TRAVEL = 0.8;

export default {
  name: 'Spear_ButtStrike',
  // range: distance to the target (m) the hit is authored for
  events: { hit: 0.32, cancel: 0.5, range: 1.2 },
  keys: [
    { t: 0, label: 'guard' },
    // Counter-wind: tip up and out to the right, butt low behind, hips and chest wound right
    {
      t: 0.14,
      phase: 'antic',
      label: 'counter',
      pelvis: [-0.05, -0.18, -0.1],
      pelvisYPR: [-50, 4, -4],
      chestYPR: [-35, 0, 6],
      spear: { grip: [-0.25, 0.85, -0.1], yaw: -40, pitch: 30 },
      elbowR: [-0.4, -0.7, -0.5],
      footL: { heel: 10 },
    },
    { t: 0.19, phase: 'antic', pelvis: [-0.05, -0.19, -0.11], spear: { yaw: -43, pitch: 32 } },
    // Long step in, the spear turning round the left side
    {
      t: 0.26,
      phase: 'strike',
      label: 'step',
      ease: 'in2',
      root: [0, 0, 0.45],
      pelvis: [-0.02, -0.15, -0.03],
      pelvisYPR: [-10, 10, 0],
      chestYPR: [10, 6, 0],
      spear: { grip: [-0.16, 1.0, 0.25], yaw: 70, pitch: -10, front: 0.48 },
      elbowR: [-0.4, -0.7, -0.2],
      elbowL: [0.35, -0.8, 0.0],
      footL: { ball: footL(0.45, 0.1), heel: -5 },
      footR: { ball: footR(0.12), heel: 15 },
    },
    // Hit: butt end driving up into the chin, tip low behind on the left
    {
      t: 0.32,
      phase: 'strike',
      label: 'hit',
      ease: 'linear',
      root: [0, 0, TRAVEL],
      pelvis: [0.03, -0.16, 0.0],
      pelvisYPR: [20, 14, -6],
      chestYPR: [38, 2, -12],
      clavR: [22, 10],
      spear: { grip: [-0.04, 1.32, 0.5], yaw: 145, pitch: -40, front: 0.45 },
      elbowR: [-0.35, -0.7, 0.0],
      elbowL: [0.4, -0.5, -0.2],
      footL: { ball: footL(0.82), heel: 0 },
      footR: { ball: footR(0.48), heel: 35 },
      kneeL: [0.1, 0.3, 0.7],
    },
    // Follow-through: carried up and back, arms high
    {
      t: 0.37,
      phase: 'strike',
      ease: 'out2',
      pelvis: [0.03, -0.12, -0.02],
      chestYPR: [44, -8, -14],
      spear: { grip: [-0.02, 1.44, 0.46], yaw: 150, pitch: -47 },
    },
    { t: 0.5, phase: 'hold', label: 'hold', spear: { grip: [-0.02, 1.43, 0.45], yaw: 151 }, pelvis: [0.03, -0.125, -0.02] },
    // Recovery: the spear swings back round to the front, the rear foot steps up
    {
      t: 0.66,
      phase: 'recover',
      label: 'recover',
      ease: 'out',
      pelvis: [-0.02, -0.1, -0.03],
      pelvisYPR: [-26, 6, 0],
      chestYPR: [-10, 4, 0],
      clavR: [0, 0],
      spear: { grip: [-0.2, 0.96, 0.08], yaw: -4, pitch: 14, front: 0.5 },
      elbowR: [-0.43, -0.78, -0.42],
      elbowL: [0.23, -0.98, 0.3],
      footR: { ball: footR(TRAVEL - 0.15, 0.07), heel: 8 },
      kneeL: [0.05, 0.3, 0.6],
    },
    { t: 0.74, phase: 'recover', footR: { ball: footR(TRAVEL), heel: 0 }, spear: { yaw: 8, pitch: 8 } },
    { t: 0.86, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
