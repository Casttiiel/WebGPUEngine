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
  SLIDE = 'slide',
  WALL_JUMP = 'wall_jump',
  DIVE = 'dive',

  // Camera
  LOOK_UP = 'look_up',
  LOOK_DOWN = 'look_down',
  LOOK_LEFT = 'look_left',
  LOOK_RIGHT = 'look_right',
}
