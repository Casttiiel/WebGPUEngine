/**
 * Enum de acciones del juego (game actions)
 * Estas son acciones abstractas que pueden ser mapeadas a diferentes teclas/botones
 */
export enum GameAction {
  // Movement
  MOVE_FORWARD = 'move_forward',
  MOVE_BACKWARD = 'move_backward',
  MOVE_LEFT = 'move_left',
  MOVE_RIGHT = 'move_right',

  // Actions
  JUMP = 'jump',
  ROLL = 'roll',
  DIVE = 'dive',
  DASH = 'dash',
  THROW = 'throw',

  // Camera
  LOOK_UP = 'look_up',
  LOOK_DOWN = 'look_down',
  LOOK_LEFT = 'look_left',
  LOOK_RIGHT = 'look_right',

  // Combat
  LIGHT_ATTACK = 'light_attack',
  HEAVY_ATTACK = 'heavy_attack',
  SHIELD = 'shield',

  // Interaction
  INTERACT = 'interact',

  // Abilities
  ABILITY_Q = 'ability_q',
  ABILITY_E = 'ability_e',
  ABILITY_R = 'ability_r',

  // UI
  PAUSE = 'pause',
}
