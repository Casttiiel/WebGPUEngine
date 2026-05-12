/**
 * Estados de movimiento del Character Controller
 * Estos estados son mutuamente exclusivos - el personaje solo puede estar en uno a la vez
 */
export enum CharacterMovementState {
  /** Estado de movimiento normal (caminando, corriendo, en el aire normalmente) */
  IDLE = 'idle',

  /** Ejecutando un wall run */
  WALL_RUNNING = 'wall_running',

  /** Trepando un obstáculo (mantling) */
  MANTLING = 'mantling',

  /** Saltando por encima de un obstáculo bajo (vault) */
  VAULTING = 'vaulting',

  /** Columpiándose en una barra */
  SWINGING = 'swinging',

  /** Ejecutando un roll */
  ROLLING = 'rolling',

  /** Ejecutando un dash hacia un punto específico */
  DASHING = 'dashing',

  /** Esquivando (dodge corto en dirección de input) */
  DODGING = 'dodging',

  /** Tirón hacia un punto de grapple (daga enganchada) */
  GRAPPLING = 'grappling',
}
