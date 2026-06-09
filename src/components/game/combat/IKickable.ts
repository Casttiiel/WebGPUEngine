import type { vec3 } from 'gl-matrix';

/**
 * IKickable — Cualquier componente que quiera recibir knockback implementa esta interfaz.
 *
 * Implementaciones conocidas:
 *  - KickableComponent  → entidades con rigid body dinámico (props, cajas, etc.)
 *  - EnemyControllerComponent → personajes con KCC; el knockback va a través del controller.
 */
export interface IKickable {
  applyKnockback(impulse: vec3, duration?: number): void;
  /** Returns true while the entity is in a stun / knockback state. */
  isStunned(): boolean;
}
