/**
 * MsgType — Identificadores de todos los tipos de mensaje del sistema ECS.
 *
 * Cada componente se suscribe solo a los tipos que le interesan mediante
 * `MsgDispatcher.register(MsgType.X, 'componentKey', handler)` en su
 * método estático `registerMsgs()`.
 */
export enum MsgType {
  // ── Combate (entrada) ─────────────────────────────────────────────────
  DAMAGE = 'damage', // Enviar daño a una entidad

  // ── Combate (salida) ────────────────────────────────────────────────
  ON_DAMAGED = 'on_damaged', // La entidad recibió daño (emitido por HealthComponent)
  ON_DEATH = 'on_death', // La entidad murió   (emitido por HealthComponent)
  ON_HEALED = 'on_healed', // La entidad fue curada (emitido por HealthComponent)

  // ── Física / Colisiones ────────────────────────────────────────────────
  ON_CONTACT = 'on_contact', // Contacto físico (balas, trampas, etc.)

  // ── Ciclo de vida ──────────────────────────────────────────────────
  ENTITY_CREATED = 'entity_created', // Entidad recién creada y lista
}
