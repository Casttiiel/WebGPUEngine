/**
 * Estados de combate del PlayerController.
 * Mutuamente exclusivos — el jugador solo puede estar en uno a la vez.
 */
export enum PlayerCombatState {
  /** Sin acción de combate activa */
  IDLE = 'idle',

  /** Ejecutando ataque ligero */
  LIGHT_ATTACKING = 'light_attacking',

  /** Ejecutando ataque pesado */
  HEAVY_ATTACKING = 'heavy_attacking',

  /** Bloqueando con escudo */
  BLOCKING = 'blocking',

  /** Ventana de parry activa */
  PARRYING = 'parrying',

  /** Dash de combate */
  DASHING = 'dashing',
}
