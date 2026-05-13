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

/** Emitido por ColliderComponent (sensor) cuando otro collider ENTRA. */
export interface TMsgTriggerEnter {
  /** ID de física de la entidad que entró en el sensor. */
  otherEntityId: number;
}

/** Emitido por ColliderComponent (sensor) cuando otro collider SALE. */
export interface TMsgTriggerExit {
  /** ID de física de la entidad que salió del sensor. */
  otherEntityId: number;
}

/** Emitido por StaminaComponent cuando se gasta stamina. */
export interface TMsgStaminaSpent {
  amount: number; // Cantidad gastada
  current: number; // Stamina restante
}

/** Emitido por StaminaComponent cuando la stamina llega a 0. */
export interface TMsgStaminaDepleted {
  // Sin payload adicional.
}

/** Emitido por StaminaComponent cuando la stamina vuelve al máximo. */
export interface TMsgStaminaRestored {
  // Sin payload adicional.
}

/** Emitido por BloodComponent cuando se gasta sangre. */
export interface TMsgBloodSpent {
  amount: number; // Cantidad gastada
  current: number; // Sangre restante
}

/** Emitido por BloodComponent cuando la sangre llega a 0. */
export interface TMsgBloodDepleted {
  // Sin payload adicional.
}

/** Emitido por BloodComponent cuando la sangre vuelve al máximo. */
export interface TMsgBloodRestored {
  // Sin payload adicional.
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
  triggerEnter(payload: TMsgTriggerEnter): IMsg<TMsgTriggerEnter> {
    return { type: MsgType.TRIGGER_ENTER, payload };
  },
  triggerExit(payload: TMsgTriggerExit): IMsg<TMsgTriggerExit> {
    return { type: MsgType.TRIGGER_EXIT, payload };
  },
  staminaSpent(payload: TMsgStaminaSpent): IMsg<TMsgStaminaSpent> {
    return { type: MsgType.STAMINA_SPENT, payload };
  },
  staminaDepleted(): IMsg<TMsgStaminaDepleted> {
    return { type: MsgType.STAMINA_DEPLETED, payload: {} };
  },
  staminaRestored(): IMsg<TMsgStaminaRestored> {
    return { type: MsgType.STAMINA_RESTORED, payload: {} };
  },
  bloodSpent(payload: TMsgBloodSpent): IMsg<TMsgBloodSpent> {
    return { type: MsgType.BLOOD_SPENT, payload };
  },
  bloodDepleted(): IMsg<TMsgBloodDepleted> {
    return { type: MsgType.BLOOD_DEPLETED, payload: {} };
  },
  bloodRestored(): IMsg<TMsgBloodRestored> {
    return { type: MsgType.BLOOD_RESTORED, payload: {} };
  },
  entityCreated(): IMsg<TMsgEntityCreated> {
    return { type: MsgType.ENTITY_CREATED, payload: {} };
  },
  resize(payload: TMsgResize): IMsg<TMsgResize> {
    return { type: MsgType.RESIZE, payload };
  },
};
