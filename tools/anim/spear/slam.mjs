// 4 — Slam (finisher). Built on contrast: a deep, readable load; an explosive leap of ~1 m with
// hang time at the apex (body arched like a drawn bow, spear loaded behind the head); a 3-frame
// drop that buries the tip in the ground; a heavy squash and a long hold; then the spear is
// yanked out and flicked back into the guard.
// The jump height lives in the pelvis/feet (root Y is not extracted), so in the air the grip
// targets carry the jump too (they are relative to the root, not the pelvis).
import { guardAt, footL, footR } from './common.mjs';

const TRAVEL = 0.6;
const JUMP = 0.95;

export default {
  name: 'Spear_Slam',
  // range: distance to the target (m) the hit is authored for
  events: { hit: 0.7, cancel: 1.36, range: 1.9 },
  keys: [
    { t: 0, label: 'guard' },
    // Drop: weight sinks, spear dips
    {
      t: 0.1,
      phase: 'antic',
      label: 'drop',
      pelvis: [-0.03, -0.2, -0.08],
      pelvisYPR: [-24, 12, 0],
      chestYPR: [-10, 14, 0],
      spear: { grip: [-0.22, 0.82, 0.02], pitch: -5 },
      kneeL: [0.1, 0.3, 0.7],
      kneeR: [-0.3, 0.3, 0.6],
    },
    // Gather: as low as it goes, coiled, rear heel up — loaded
    {
      t: 0.2,
      phase: 'antic',
      label: 'gather',
      pelvis: [-0.03, -0.34, -0.12],
      pelvisYPR: [-20, 22, 0],
      chestYPR: [-6, 20, 0],
      spear: { grip: [-0.28, 0.72, -0.12], yaw: 10, pitch: -20 },
      footR: { heel: 10 },
    },
    { t: 0.25, phase: 'antic', pelvis: [-0.03, -0.355, -0.13] },
    // Take-off: everything stretches up at once, spear swings up in front
    {
      t: 0.31,
      phase: 'antic',
      label: 'takeoff',
      ease: 'in2',
      root: [0, 0, 0.12],
      pelvis: [-0.02, 0.12, -0.02],
      pelvisYPR: [-14, 0, 0],
      chestYPR: [-4, -6, 0],
      spear: { grip: [-0.12, 1.45, 0.05], yaw: 6, pitch: 55, front: 0.4, rollR: 10, rollL: -60 },
      elbowR: [-0.5, -0.1, 0.1],
      elbowL: [0.5, -0.1, 0.2],
      footL: { ball: footL(0.04, 0.03), heel: 40 },
      footR: { ball: footR(0.04, 0.06), heel: 45 },
    },
    // Rising: knees tuck, the spear passes overhead
    {
      t: 0.42,
      phase: 'antic',
      label: 'rise',
      ease: 'out2',
      root: [0, 0, 0.35],
      pelvis: [-0.02, JUMP - 0.2, -0.04],
      pelvisYPR: [-12, -4, 0],
      chestYPR: [-2, -14, 0],
      spear: { grip: [-0.08, 1.56 + JUMP - 0.2, 0.08], pitch: 100, front: 0.35 },
      elbowR: [-0.5, 0.0, 0.2],
      elbowL: [0.5, 0.0, 0.25],
      // tucked: feet ~0.65 m under the hips
      footL: { ball: footL(0.3, JUMP + 0.1), heel: -10 },
      footR: { ball: footR(0.25, JUMP - 0.05), heel: 10 },
    },
    // Apex: arched like a drawn bow, spear loaded behind the head
    {
      t: 0.52,
      phase: 'hold',
      label: 'apex',
      root: [0, 0, 0.45],
      pelvis: [-0.02, JUMP, -0.06],
      pelvisYPR: [-10, -8, 0],
      chestYPR: [-2, -21, 0],
      spear: { grip: [-0.08, 1.54 + JUMP, 0.04], pitch: 135 },
      footL: { ball: footL(0.42, JUMP + 0.42), heel: -20 },
      footR: { ball: footR(0.36, JUMP + 0.28), heel: 5 },
    },
    // Hang time
    {
      t: 0.6,
      phase: 'hold',
      root: [0, 0, 0.5],
      pelvis: [-0.02, JUMP + 0.03, -0.06],
      chestYPR: [-2, -24, 0],
      spear: { grip: [-0.08, 1.52 + JUMP, 0.02], pitch: 140 },
      footL: { ball: footL(0.47, JUMP + 0.44), heel: -20 },
      footR: { ball: footR(0.41, JUMP + 0.3), heel: 5 },
    },
    // Slam: 3 frames from the apex to the ground, the tip buried in front
    {
      t: 0.7,
      phase: 'strike',
      label: 'hit',
      ease: 'in2',
      root: [0, 0, TRAVEL],
      pelvis: [0.0, -0.36, 0.02],
      pelvisYPR: [-6, 28, 0],
      chestYPR: [6, 34, 0],
      clavR: [16, 0],
      clavL: [-6, 0],
      spear: { grip: [-0.06, 1.05, 0.4], yaw: 4, pitch: -38, front: 0.45, rollR: 30, rollL: -40 },
      elbowR: [-0.35, -0.8, -0.2],
      elbowL: [0.3, -0.8, 0.3],
      footL: { ball: footL(TRAVEL), heel: 0 },
      footR: { ball: footR(TRAVEL - 0.05), heel: 25 },
      kneeL: [0.15, 0.3, 0.7],
      kneeR: [-0.3, 0.3, 0.6],
      lookWeight: 0.5,
    },
    // Squash: the body keeps sinking, the hands drive the shaft deeper along its own line
    {
      t: 0.75,
      phase: 'strike',
      ease: 'out2',
      pelvis: [0.0, -0.43, 0.03],
      chestYPR: [6, 38, 0],
      spear: { grip: [-0.06, 1.01, 0.45] },
    },
    // Long hold on the impact pose
    { t: 0.98, phase: 'hold', label: 'hold', pelvis: [0.0, -0.41, 0.02], chestYPR: [6, 35, 0] },
    // Yank the spear out of the ground, rising
    {
      t: 1.1,
      phase: 'recover',
      label: 'yank',
      ease: 'out',
      pelvis: [-0.02, -0.2, -0.02],
      pelvisYPR: [-22, 10, 0],
      chestYPR: [-8, 14, 0],
      clavR: [0, 0],
      clavL: [0, 0],
      spear: { grip: [-0.18, 1.0, 0.16], yaw: 6, pitch: -6, front: 0.5 },
      elbowR: [-0.43, -0.78, -0.42],
      elbowL: [0.23, -0.98, 0.3],
      footR: { ball: footR(TRAVEL), heel: 0 },
      kneeL: [0.05, 0.3, 0.6],
      kneeR: [-0.35, 0.3, 0.45],
      lookWeight: 0.8,
    },
    // Flick the tip back up past the guard line
    { t: 1.22, phase: 'recover', pelvis: [-0.02, -0.09, -0.03], spear: { grip: [-0.2, 0.95, 0.06], pitch: 15 } },
    { t: 1.36, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
