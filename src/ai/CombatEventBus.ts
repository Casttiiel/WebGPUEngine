/**
 * CombatEventBus — Bloque 5: bus de eventos de combate de grupo.
 *
 * Bus estático y tipado. Cualquier sistema emite un evento; todos los
 * suscriptores registrados para ese tipo lo reciben inmediatamente.
 *
 * Uso:
 *   // Suscribirse:
 *   const unsub = CombatEventBus.on('ally_dead', handler);
 *   // Emitir:
 *   CombatEventBus.emit('ally_dead', { position: [...] });
 *   // Desuscribirse (en dispose):
 *   unsub();
 */

export type CombatEventType =
  | 'ally_attacking'   // Un aliado ha adquirido token y va a atacar
  | 'ally_dead'        // Un aliado ha muerto — los demás pueden reasignar posición
  | 'player_spotted'   // Un enemigo ha visto al jugador por primera vez
  | 'player_retreating'// El jugador está huyendo (distancia aumentando rápido)
  | 'player_damaged';  // El jugador ha recibido daño — resetea el escalado de presión

export interface CombatEventPayload {
  position?: [number, number, number];
  entityId?: number;
}

type Handler = (payload: CombatEventPayload) => void;

export class CombatEventBus {
  private static readonly _listeners = new Map<CombatEventType, Set<Handler>>();

  /** Suscribe un handler. Devuelve la función de desuscripción. */
  static on(type: CombatEventType, handler: Handler): () => void {
    let set = CombatEventBus._listeners.get(type);
    if (!set) {
      set = new Set();
      CombatEventBus._listeners.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Emite un evento a todos los suscriptores registrados para ese tipo. */
  static emit(type: CombatEventType, payload: CombatEventPayload = {}): void {
    CombatEventBus._listeners.get(type)?.forEach((h) => h(payload));
  }

  /** Limpia todos los suscriptores — llamar en reset de escena. */
  static clear(): void {
    CombatEventBus._listeners.clear();
  }
}
