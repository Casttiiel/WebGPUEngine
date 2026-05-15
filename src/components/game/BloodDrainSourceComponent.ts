import { vec3 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { TransformComponent } from '../core/TransformComponent';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { BloodComponent } from './BloodComponent';
import type { IMsg, TMsgTriggerEnter, TMsgTriggerExit } from '../../core/ecs/Msg';

/**
 * BloodDrainSourceComponent — Fuente de sangre que el Bloodmancer puede drenar.
 *
 * Coloca este componente (junto a un sphere_collider sensor con el grupo
 * BLOOD_DRAIN_TRIGGER) sobre cualquier entidad que quieras que sea drennable.
 *
 * Mecánica:
 * - El jugador entra en el radio del trigger → queda registrado en `inRangeOf`.
 * - El BloodmancerControllerComponent detecta INTERACT (E) y llama `drain()`.
 * - Cuando la fuente se agota deja de entregar sangre.
 *
 * Uso en JSON / prefab:
 * ```json
 * "blood_drain_source": { "totalBlood": 100, "drainRate": 40 }
 * ```
 */
export class BloodDrainSourceComponent extends Component {
  /** Sangre total disponible en esta fuente. */
  private totalBlood: number = 100;
  /** Sangre restante en la fuente. */
  private remainingBlood: number = 100;
  /** Velocidad de drenado en unidades de sangre por segundo. */
  private drainRate: number = 40;
  /** Si es false, los triggers y drain requests son ignorados. */
  private active: boolean = true;

  /**
   * Registro estático: playerId → drain source actualmente en rango.
   * El controller consulta esto para saber si hay una fuente disponible.
   */
  private static readonly inRangeOf: Map<number, BloodDrainSourceComponent> = new Map();
  /** Fuentes activas para detección por distancia (sin trigger físico). */
  private static readonly activeSources = new Set<BloodDrainSourceComponent>();

  /** Devuelve la fuente de sangre en rango del jugador dado, o undefined. */
  public static getInRange(playerId: number): BloodDrainSourceComponent | undefined {
    return BloodDrainSourceComponent.inRangeOf.get(playerId);
  }

  /**
   * Returns the nearest active drain source within maxRange of playerPos.
   * Fallback for dead enemies that have no physics sensor.
   */
  public static getNearest(
    playerPos: vec3,
    maxRange: number,
  ): BloodDrainSourceComponent | undefined {
    let closest: BloodDrainSourceComponent | undefined;
    let closestDist = maxRange;
    for (const src of BloodDrainSourceComponent.activeSources) {
      if (src.isDepleted()) continue;
      const tc = src.getOwner().getComponent('transform') as TransformComponent | null;
      if (!tc) continue;
      const dist = vec3.distance(playerPos, tc.getTransform().getWorldPosition() as vec3);
      if (dist < closestDist) {
        closestDist = dist;
        closest = src;
      }
    }
    return closest;
  }

  public load(data: { totalBlood?: number; drainRate?: number; startActive?: boolean }): void {
    this.totalBlood = data?.totalBlood ?? this.totalBlood;
    this.drainRate = data?.drainRate ?? this.drainRate;
    this.remainingBlood = this.totalBlood;
    this.active = data?.startActive ?? true;
    if (this.active) BloodDrainSourceComponent.activeSources.add(this);
  }

  /** Activa esta fuente (llamado cuando el enemigo muere). */
  public activate(): void {
    if (this.active) return;
    this.active = true;
    BloodDrainSourceComponent.activeSources.add(this);
  }

  // ── Mensajes de trigger ───────────────────────────────────────────────────

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.TRIGGER_ENTER, 'blood_drain_source', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerEnter>).payload;
      (comp as BloodDrainSourceComponent).onEntityEnter(otherEntityId);
    });
    MsgDispatcher.register(MsgType.TRIGGER_EXIT, 'blood_drain_source', (comp, msg) => {
      const { otherEntityId } = (msg as IMsg<TMsgTriggerExit>).payload;
      (comp as BloodDrainSourceComponent).onEntityExit(otherEntityId);
    });
  }

  private onEntityEnter(entityId: number): void {
    if (!this.active) return;
    const entity = Engine.getPhysics().getEntityById(entityId);
    if (entity?.hasComponent('blood')) {
      BloodDrainSourceComponent.inRangeOf.set(entityId, this);
    }
  }

  private onEntityExit(entityId: number): void {
    // Solo eliminar si este componente es el registrado para ese jugador
    if (BloodDrainSourceComponent.inRangeOf.get(entityId) === this) {
      BloodDrainSourceComponent.inRangeOf.delete(entityId);
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  /**
   * Drena sangre de esta fuente hacia el BloodComponent del jugador.
   * Llamado por el controller cuando el jugador mantiene INTERACT.
   * @returns cantidad real drenada (0 si la fuente está agotada)
   */
  public drain(deltaTime: number, bloodComp: BloodComponent): number {
    if (this.remainingBlood <= 0) return 0;
    const amount = Math.min(this.drainRate * deltaTime, this.remainingBlood);
    this.remainingBlood -= amount;
    bloodComp.restore(amount);
    return amount;
  }

  public getRemainingBlood(): number {
    return this.remainingBlood;
  }

  public getRemainingRatio(): number {
    return this.remainingBlood / this.totalBlood;
  }

  public isDepleted(): boolean {
    return this.remainingBlood <= 0;
  }

  public override update(_deltaTime: number): void {}
  public override renderInMenu(): void {}
  public override renderDebug(): void {}
  public override dispose(): void {
    BloodDrainSourceComponent.activeSources.delete(this);
  }
}
