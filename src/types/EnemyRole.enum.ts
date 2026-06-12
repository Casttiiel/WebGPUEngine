/**
 * EnemyRole — Bloque 6: roles de IA asignados por el CombatDirectorComponent.
 *
 * El Director reasigna roles dinámicamente según el contexto de combate.
 */
export enum EnemyRole {
  /** Comportamiento por defecto: intentar adquirir token y atacar. */
  AGGRESSOR = 'aggressor',
  /** Orbitar hacia el lado opuesto del AGGRESSOR principal para flanquear. */
  FLANKER = 'flanker',
  /** Mantenerse lejos y hostigar con ataques lentos. */
  HARASSER = 'harasser',
  /** Reservado — quedarse atrás (uso futuro). */
  SUPPORT = 'support',
}
