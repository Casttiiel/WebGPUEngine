import type { Entity } from './Entity';
import type { IMsg } from './Msg';
import type { Component } from './Component';
import { MsgType } from '../../types/MsgType.enum';

/** Firma de un handler de mensaje. Recibe el componente ya resuelto y el mensaje. */
type MsgHandler = (component: Component, msg: IMsg) => void;

interface MsgHandlerSlot {
  /** Key con la que está registrado el componente en la entidad (e.g. 'health'). */
  componentKey: string;
  handler: MsgHandler;
}

/**
 * MsgDispatcher — Registro global de suscripciones de mensajes.
 *
 * Equivalente al `all_registered_msgs` del motor C++ original.
 *
 * Uso:
 * ```ts
 * // En el método estático registerMsgs() de cada componente:
 * MsgDispatcher.register(MsgType.DAMAGE, 'health', (comp, msg) => {
 *   (comp as HealthComponent).onMsgDamage(msg as IMsg<TMsgDamage>);
 * });
 *
 * // Para enviar un mensaje a una entidad:
 * entity.sendMsg(Msg.damage({ amount: 10, instigator: null }));
 * ```
 */
export class MsgDispatcher {
  private static readonly slots = new Map<MsgType, MsgHandlerSlot[]>();

  /**
   * Suscribe un componente a un tipo de mensaje.
   * Llamar una vez por tipo desde el `static registerMsgs()` del componente.
   *
   * @param msgType  Tipo de mensaje al que se suscribe.
   * @param componentKey  Clave del componente en la entidad (e.g. `'health'`).
   * @param handler  Función que recibe el componente resuelto y el mensaje.
   */
  public static register(msgType: MsgType, componentKey: string, handler: MsgHandler): void {
    let list = MsgDispatcher.slots.get(msgType);
    if (!list) {
      list = [];
      MsgDispatcher.slots.set(msgType, list);
    }
    list.push({ componentKey, handler });
  }

  /**
   * Despacha un mensaje a todos los componentes suscritos que la entidad posea.
   * Llamado internamente por `entity.sendMsg(msg)`.
   */
  public static dispatch(entity: Entity, msg: IMsg): void {
    const list = MsgDispatcher.slots.get(msg.type);
    if (!list) return;

    for (const slot of list) {
      const comp = entity.getComponent(slot.componentKey);
      if (comp) {
        slot.handler(comp, msg);
      }
    }
  }

  /** Limpia todas las suscripciones (útil para tests). */
  public static clear(): void {
    MsgDispatcher.slots.clear();
  }
}
