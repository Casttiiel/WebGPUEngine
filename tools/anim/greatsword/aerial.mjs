// 3 — Aerial spin (finisher): from the sword held high (the launcher's landing — the entry pose
// when chained) the fighter drops into a deep crouch with the blade wound back on the right,
// launches ~0.9 m up turning a full 360° in the air with the blade out like a rotor, brings it
// overhead at the end of the turn and crashes down: the blade buries itself in the ground, the
// body squashes deep and holds; then the sword is wrenched out.
import { guardAt, footL, footR } from './common.mjs';
import { HIGH_LANDED } from './launcher.mjs';

const TRAVEL = 0.6;
const JUMP = 0.9;

/** Airborne spin pose (body frame): blade out at chest height, legs tucked. */
const ROTOR = {
  pelvisYPR: [10, 4, 0],
  chestYPR: [18, 0, -10],
  clavR: [10, 0],
  spear: { grip: [0.02, 1.3 + JUMP, 0.4], yaw: 6, pitch: 4 },
  elbowR: [-0.3, -0.8, 0.2],
  elbowL: [0.3, -0.8, 0.2],
  footL: { ball: footL(0.05, JUMP + 0.4), heel: -15 },
  footR: { ball: footR(0.15, JUMP + 0.3), heel: 0 },
};

export default {
  name: 'Greatsword_AerialSpin',
  // range: distance to the target (m) the hit is authored for; entry: pose a chained hit starts from
  events: { hit: 0.86, spinHit: 0.6, cancel: 1.56, entry: 0.28, range: 1.7 },
  keys: [
    { t: 0, label: 'guard', spin: 0, spinFeet: 1, spinPivot: [0, -0.05] },
    // (standalone) raise the sword — chained hits start here
    { t: 0.28, phase: 'antic', label: 'high', ...HIGH_LANDED },
    // Crouch, blade wound back low on the right
    {
      t: 0.42,
      phase: 'antic',
      label: 'crouch',
      pelvis: [-0.03, -0.34, -0.1],
      pelvisYPR: [-45, 16, -4],
      chestYPR: [-35, 14, 8],
      spear: { grip: [-0.3, 0.92, -0.06], yaw: -150, pitch: -8 },
      elbowR: [-0.3, -0.75, -0.3],
      elbowL: [0.1, -0.8, 0.35],
      kneeL: [0.1, 0.3, 0.7],
      kneeR: [-0.3, 0.3, 0.6],
    },
    { t: 0.48, phase: 'antic', pelvis: [-0.03, -0.355, -0.11] },
    // Launch: explode up, the turn starts, blade swinging round
    {
      t: 0.54,
      phase: 'strike',
      label: 'launch',
      ease: 'in2',
      root: [0, 0, 0.15],
      spin: 40,
      pelvis: [-0.02, 0.2, -0.02],
      pelvisYPR: [-15, 0, 0],
      chestYPR: [-20, -4, 4],
      spear: { grip: [-0.3, 1.3, 0.1], yaw: -80, pitch: 6 },
      footL: { ball: footL(0.02, 0.06), heel: 40 },
      footR: { ball: footR(0.04, 0.06), heel: 45 },
    },
    // The rotor: a full turn in the air
    { t: 0.6, phase: 'strike', label: 'rotor', spin: 140, root: [0, 0, 0.3], pelvis: [0, JUMP - 0.15, 0], ...ROTOR },
    { t: 0.67, phase: 'strike', spin: 250, root: [0, 0, 0.42], pelvis: [0, JUMP, 0] },
    { t: 0.74, phase: 'hold', label: 'apex', spin: 340, root: [0, 0, 0.5], pelvis: [0, JUMP + 0.02, 0] },
    // End of the turn: sword swung up overhead
    {
      t: 0.79,
      phase: 'hold',
      label: 'over',
      spin: 360,
      root: [0, 0, 0.54],
      pelvis: [-0.02, JUMP - 0.05, -0.06],
      pelvisYPR: [-10, -8, 0],
      chestYPR: [-2, -22, 0],
      clavR: [0, 0],
      spear: { grip: [-0.06, 1.55 + JUMP, 0.04], yaw: 0, pitch: 125 },
      elbowR: [-0.5, 0.0, 0.2],
      elbowL: [0.5, 0.0, 0.25],
    },
    // Crash down: the blade buries itself in front
    {
      t: 0.86,
      phase: 'strike',
      label: 'hit',
      ease: 'in2',
      root: [0, 0, TRAVEL],
      pelvis: [0.0, -0.34, 0.02],
      pelvisYPR: [-5, 26, 0],
      chestYPR: [5, 32, 0],
      clavR: [14, 0],
      clavL: [-8, 0],
      spear: { grip: [-0.04, 1.0, 0.5], yaw: 0, pitch: -44 },
      elbowR: [-0.3, -0.85, 0.2],
      elbowL: [0.3, -0.85, 0.2],
      footL: { ball: footL(TRAVEL), heel: 0 },
      footR: { ball: footR(TRAVEL - 0.15), heel: 30 },
      kneeL: [0.15, 0.3, 0.7],
      kneeR: [-0.35, 0.3, 0.55],
      lookWeight: 0.5,
    },
    { t: 0.92, phase: 'strike', ease: 'out2', pelvis: [0.0, -0.4, 0.03], chestYPR: [5, 38, 0], spear: { grip: [-0.04, 0.96, 0.53] } },
    { t: 1.2, phase: 'hold', label: 'hold', pelvis: [0.0, -0.38, 0.02], chestYPR: [5, 35, 0] },
    // Wrench it out
    {
      t: 1.36,
      phase: 'recover',
      label: 'wrench',
      ease: 'out',
      pelvis: [-0.03, -0.17, -0.03],
      pelvisYPR: [-24, 12, 0],
      chestYPR: [-8, 14, 0],
      clavR: [0, 0],
      clavL: [0, 0],
      spear: { grip: [-0.1, 0.98, 0.26], yaw: 4, pitch: -2 },
      footR: { ball: footR(TRAVEL - 0.1, 0.07), heel: 8 },
      kneeL: [0.1, 0.3, 0.6],
      kneeR: [-0.4, 0.3, 0.45],
      lookWeight: 0.8,
    },
    { t: 1.46, phase: 'recover', pelvis: [-0.02, -0.11, -0.04], spear: { grip: [-0.06, 0.98, 0.2], pitch: 40 }, footR: { ball: footR(TRAVEL), heel: 0 } },
    { t: 1.56, phase: 'recover', label: 'guard', ...guardAt(TRAVEL) },
  ],
};
