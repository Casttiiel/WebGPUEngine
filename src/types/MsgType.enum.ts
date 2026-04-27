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
  TRIGGER_ENTER = 'trigger_enter', // Otro collider ENTRÓ en el sensor de esta entidad
  TRIGGER_EXIT = 'trigger_exit', // Otro collider SALIÓ del sensor de esta entidad
  // ── Render / Resolución ─────────────────────────────────────────────
  RESIZE = 'resize', // Resolución del render ha cambiado

  // ── Stamina (salida) ────────────────────────────────────────────────
  STAMINA_SPENT = 'stamina_spent', // Se gastó stamina (emitido por StaminaComponent)
  STAMINA_DEPLETED = 'stamina_depleted', // Stamina llegó a 0 (emitido por StaminaComponent)
  STAMINA_RESTORED = 'stamina_restored', // Stamina volvió al máximo (emitido por StaminaComponent)

  // ── Ciclo de vida ──────────────────────────────────────────────────
  ENTITY_CREATED = 'entity_created', // Entidad recién creada y lista
}
