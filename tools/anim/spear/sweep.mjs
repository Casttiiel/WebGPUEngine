// 2 — Sweep: a huge horizontal arc (~280°), right → left. The wind-up turns the back to the enemy
// with the tip trailing behind the right shoulder; the hips fire first, the shoulders lag, a long
// step carries the cut through the front at chest height; the weapon's momentum over-rotates the
// body and drags the rear foot around. Exaggerated on purpose — weight over realism.
import { guardAt, footL, footR } from './common.mjs';

const TRAVEL = 0.55;

export default {
  name: 'Spear_Sweep',
  // range: distance to the target (m) the hit is authored for
  events: { hit: 0.37, cancel: 0.58, range: 2.3 },
  keys: [
    { t: 0, label: 'guard' },
    // Wind: back to the enemy, tip trailing behind the right shoulder, weight on the rear leg
    {
      t: 0.2,
      phase: 'antic',
      label: 'wind',
      pelvis: [-0.06, -0.17, -0.1],
      pelvisYPR: [-62, 4, -6],
      chestYPR: [-45, -2, 8],
      spear: { grip: [-0.3, 1.08, -0.16], yaw: -150, pitch: 14, front: 0.3, rollR: 20, rollL: -50 },
      elbowR: [-0.3, -0.7, -0.3],
      elbowL: [0.0, -0.8, 0.4],
      footL: { heel: 15 },
      kneeR: [-0.4, 0.3, 0.4],
    },
    // Tension
    { t: 0.26, phase: 'antic', spear: { yaw: -156, pitch: 15 }, chestYPR: [-48, -2, 8], pelvis: [-0.06, -0.18, -0.11] },
    // Step: hips already turning, shoulders still wound, the tip coming round the right side
    {
      t: 0.32,
      phase: 'strike',
      label: 'step',
      ease: 'in2',
      root: [0, 0, 0.3],
      pelvis: [-0.04, -0.16, -0.05],
      pelvisYPR: [-26, 8, -2],
      chestYPR: [-38, 4, 4],
      spear: { grip: [-0.36, 1.08, 0.08], yaw: -95, pitch: 8 },
      footL: { ball: footL(0.3, 0.09), heel: -5 },
      footR: { heel: 15 },
    },
    // Hit: the blade crosses the front at chest height, arms long
    {
      t: 0.37,
      phase: 'strike',
      label: 'hit',
      ease: 'linear',
      root: [0, 0, 0.5],
      pelvis: [0.0, -0.2, 0.0],
      pelvisYPR: [10, 12, 0],
      chestYPR: [20, 10, -6],
      clavR: [12, 0],
      spear: { grip: [-0.05, 1.1, 0.42], yaw: 0, pitch: 4, front: 0.25 },
      elbowR: [-0.35, -0.8, -0.2],
      elbowL: [0.25, -0.8, 0.4],
      footL: { ball: footL(0.55), heel: 0 },
      footR: { ball: footR(0.25), heel: 30 },
      kneeL: [0.1, 0.3, 0.7],
    },
    // Follow-through: momentum over-rotates the body, the rear foot is dragged round
    {
      t: 0.44,
      phase: 'strike',
      label: 'follow',
      ease: 'out2',
      root: [0, 0, TRAVEL],
      pelvisYPR: [42, 10, 4],
      chestYPR: [46, 8, -10],
      clavR: [22, 0],
      clavL: [-4, 0],
      spear: { grip: [0.34, 1.04, 0.16], yaw: 112, pitch: -3, rollR: 40, rollL: -30 },
      elbowR: [-0.2, -0.8, 0.3],
      elbowL: [0.45, -0.7, 0.0],
      footR: { ball: [-0.08, 0.015, 0.12], yaw: -15, heel: 35 },
    },
    // Moving hold, wrapped up in the follow-through
    { t: 0.58, phase: 'hold', label: 'hold', spear: { yaw: 124, pitch: -4 }, chestYPR: [49, 8, -11], pelvis: [0.0, -0.21, 0.0] },
    // Recovery: reel the spear back across, plant the rear foot back in the stance
    {
      t: 0.74,
      phase: 'recover',
      label: 'recover',
      ease: 'out',
      pelvis: [-0.02, -0.1, -0.03],
      pelvisYPR: [-26, 6, 0],
      chestYPR: [-10, 4, 0],
      clavR: [0, 0],
      clavL: [0, 0],
      spear: { grip: [-0.2, 0.95, 0.06], yaw: -2, pitch: 12, front: 0.5, rollR: 30, rollL: -40 },
      elbowR: [-0.43, -0.78, -0.42],
      elbowL: [0.23, -0.98, 0.3],
      footR: { ball: footR(TRAVEL - 0.1, 0.07), yaw: -50, heel: 8 },
      kneeL: [0.05, 0.3, 0.6],
    },
    { t: 0.82, phase: 'recover', footR: { ball: footR(TRAVEL), yaw: -55, heel: 0 }, spear: { yaw: 9 } },
    { t: 0.94, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
