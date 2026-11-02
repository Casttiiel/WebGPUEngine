// 1 — Thrust: the spear is drawn far back through the front hand with the body leaning away, then
// a long, deep lunge drives it out with a corkscrew; momentum carries the body past the hit
// before it holds. Exaggerated on purpose — weight over realism.
import { guardAt, footL, footR } from './common.mjs';

const TRAVEL = 0.64;

export default {
  name: 'Spear_Thrust',
  // range: distance to the target (m) the hit is authored for
  events: { hit: 0.34, cancel: 0.52, range: 2.6 },
  keys: [
    { t: 0, label: 'guard' },
    // Coil: weight back and down, leaning away, the shaft slides back through the front hand
    {
      t: 0.18,
      phase: 'antic',
      label: 'coil',
      pelvis: [-0.07, -0.2, -0.22],
      pelvisYPR: [-55, -2, -6],
      chestYPR: [-35, -8, 0],
      spear: { grip: [-0.3, 1.0, -0.38], yaw: 8, pitch: 14, front: 0.8 },
      elbowR: [-0.4, -0.5, -0.7],
      footL: { heel: 12 },
      kneeR: [-0.4, 0.3, 0.5],
    },
    { t: 0.24, phase: 'antic', pelvis: [-0.07, -0.21, -0.23], spear: { grip: [-0.3, 1.0, -0.4], pitch: 14.5 } },
    // Drive: hips open first, front foot flying forward, the shaft starts to twist
    {
      t: 0.29,
      phase: 'strike',
      label: 'drive',
      ease: 'in2',
      root: [0, 0, 0.3],
      pelvis: [-0.03, -0.17, -0.06],
      pelvisYPR: [-20, 10, 0],
      chestYPR: [-15, 8, 0],
      clavR: [10, 0],
      spear: { grip: [-0.18, 1.04, 0.15], yaw: 5, pitch: 7, front: 0.5, rollR: 50, rollL: -10 },
      elbowR: [-0.35, -0.8, -0.35],
      footL: { ball: footL(0.3, 0.1), heel: -6 },
      footR: { heel: 20 },
    },
    // Hit: deepest lunge, one line from the dragged rear heel to the tip
    {
      t: 0.34,
      phase: 'strike',
      label: 'hit',
      ease: 'linear',
      root: [0, 0, 0.6],
      pelvis: [0.02, -0.25, 0.02],
      pelvisYPR: [8, 22, 3],
      chestYPR: [16, 16, 0],
      clavR: [28, 0],
      clavL: [-16, 0],
      spear: { grip: [-0.04, 1.08, 0.58], yaw: 2, pitch: 3, front: 0.08, rollR: 110, rollL: 40 },
      elbowR: [-0.28, -0.9, -0.15],
      elbowL: [0.2, -0.8, 0.4],
      footL: { ball: footL(0.62), heel: 0 },
      footR: { ball: footR(0.34), heel: 45 },
      kneeL: [0.1, 0.3, 0.8],
    },
    // Momentum carries the body on past the hit
    {
      t: 0.38,
      phase: 'strike',
      ease: 'out2',
      root: [0, 0, TRAVEL],
      pelvis: [0.02, -0.27, 0.03],
      spear: { grip: [-0.04, 1.07, 0.57] },
      footR: { ball: footR(0.38), heel: 42 },
    },
    // Hold the line
    { t: 0.52, phase: 'hold', label: 'hold', pelvis: [0.02, -0.26, 0.02], spear: { grip: [-0.04, 1.07, 0.56], rollR: 106, rollL: 36 } },
    // Recovery: wrench the spear back with a tip flick, rear foot steps up
    {
      t: 0.66,
      phase: 'recover',
      label: 'retract',
      ease: 'out',
      pelvis: [-0.02, -0.12, -0.04],
      pelvisYPR: [-26, 7, 0],
      chestYPR: [-10, 5, 0],
      clavR: [2, 0],
      clavL: [0, 0],
      spear: { grip: [-0.2, 0.98, 0.1], yaw: 6, pitch: 17, front: 0.45, rollR: 30, rollL: -40 },
      elbowR: [-0.43, -0.78, -0.42],
      elbowL: [0.23, -0.98, 0.3],
      footR: { ball: footR(TRAVEL - 0.12, 0.07), heel: 8 },
      kneeL: [0.05, 0.3, 0.6],
    },
    { t: 0.74, phase: 'recover', footR: { ball: footR(TRAVEL), heel: 0 }, spear: { pitch: 7.5 }, pelvis: [-0.02, -0.085, -0.03] },
    { t: 0.86, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
