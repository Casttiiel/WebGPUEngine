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
  DASH = 'dash',
  ROLL = 'roll',
  LIGHT_ATTACK = 'light_attack',
  FIRE = 'fire',
  KICK = 'kick',

  // Alchemist powers
  ABILITY_PRIMARY   = 'ability_primary',
  ABILITY_SECONDARY = 'ability_secondary',
  POWER_NEXT        = 'power_next',

  // UI
  PAUSE = 'pause',
}
