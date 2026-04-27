import type { Entity } from './Entity';
import { MsgType } from '../../types/MsgType.enum';

// ── Payloads de cada tipo de mensaje ─────────────────────────────────────────

export interface TMsgDamage {
  amount: number;
  /** Entidad que causó el daño (puede ser null para daño ambiental). */
  instigator: Entity | null;
}

/** Emitido por HealthComponent tras procesar el daño. */
export interface TMsgOnDamaged {
  amount: number; // Daño real aplicado (clampado a vida restante)
  currentHp: number; // Vida resultante
  instigator: Entity | null;
}

/** Emitido por HealthComponent cuando la vida llega a 0. */
export interface TMsgOnDeath {
  instigator: Entity | null;
}

/** Emitido por HealthComponent tras curar. */
export interface TMsgOnHealed {
  amount: number; // Cantidad curada real
  currentHp: number; // Vida resultante
}

export interface TMsgOnContact {
  /** Entidad que entró en contacto. */
  other: Entity;
  /** Posición del contacto en espacio mundo (puede omitirse). */
  position?: [number, number, number];
}

export interface TMsgEntityCreated {
  // Sin payload adicional — la propia entidad receptora es la creada.
}

/** Emitido por ModuleRender cuando cambia la resolución del render. */
export interface TMsgResize {
  width: number;
  height: number;
}

// ── Tipo discriminado base ────────────────────────────────────────────────────

/**
 * IMsg<T> — Envoltorio de cualquier mensaje del sistema ECS.
 *
 * Uso:
 * ```ts
 * entity.sendMsg<TMsgDamage>({ type: MsgType.DAMAGE, payload: { amount: 10, instigator: null } });
 * ```
 */
export interface IMsg<T = unknown> {
  type: MsgType;
  payload: T;
}

// ── Helpers de construcción (evitan repetir el type) ─────────────────────────

export const Msg = {
  damage(payload: TMsgDamage): IMsg<TMsgDamage> {
    return { type: MsgType.DAMAGE, payload };
  },
  onDamaged(payload: TMsgOnDamaged): IMsg<TMsgOnDamaged> {
    return { type: MsgType.ON_DAMAGED, payload };
  },
  onDeath(payload: TMsgOnDeath): IMsg<TMsgOnDeath> {
    return { type: MsgType.ON_DEATH, payload };
  },
  onHealed(payload: TMsgOnHealed): IMsg<TMsgOnHealed> {
    return { type: MsgType.ON_HEALED, payload };
  },
  onContact(payload: TMsgOnContact): IMsg<TMsgOnContact> {
    return { type: MsgType.ON_CONTACT, payload };
  },
  entityCreated(): IMsg<TMsgEntityCreated> {
    return { type: MsgType.ENTITY_CREATED, payload: {} };
  },
  resize(payload: TMsgResize): IMsg<TMsgResize> {
    return { type: MsgType.RESIZE, payload };
  },
};
