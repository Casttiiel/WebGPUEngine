import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';
import { EnemyControllerComponent } from '../EnemyControllerComponent';
import { Msg } from '../../../core/ecs/Msg';
import { BestialitySystem } from './BestialitySystem';

export type BloodZoneData = {
  /** World-space center of the zone. */
  center?: [number, number, number];
  /** AoE radius in metres. Default 4. */
  radius?: number;
  /** How many seconds the zone persists. Default 9. */
  duration?: number;
  /** Damage dealt per second to enemies inside the zone. Default 5. */
  damagePerSecond?: number;
  /** Speed multiplier applied to enemies inside (0 = frozen, 1 = full speed). Default 0.4. */
  slowFactor?: number;
};

/**
 * BloodZoneComponent — Area-of-effect blood zone.
 *
 * Placed on a dynamically-spawned entity by BloodZoneSystem.
 * Each frame it checks all entities with 'enemy_controller' within its
 * radius and applies continuous damage + slow. Self-destructs when the
 * timer expires.
 */
export class BloodZoneComponent extends Component {
  private center: vec3 = vec3.create();
  private radius: number = 4;
  private duration: number = 9;
  private damagePerSecond: number = 5;
  private slowFactor: number = 0.4;

  private timer: number = 0;
  private destroyed: boolean = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public load(data: BloodZoneData): void {
    this.radius = data?.radius ?? this.radius;
    this.duration = data?.duration ?? this.duration;
    this.damagePerSecond = data?.damagePerSecond ?? this.damagePerSecond;
    this.slowFactor = data?.slowFactor ?? this.slowFactor;
    this.timer = this.duration;

    if (data?.center) {
      vec3.set(this.center, data.center[0], data.center[1], data.center[2]);
    }
  }

  public override async onAttach(): Promise<void> {
    // If no explicit center was provided, use the transform position.
    if (vec3.length(this.center) === 0) {
      const tc = this.getOwner().getComponent('transform') as TransformComponent | null;
      if (tc) {
        const pos = tc.getTransform().getWorldPosition();
        vec3.set(this.center, pos[0], pos[1], pos[2]);
      }
    }
  }

  // ── Update ────────────────────────────────────────────────────────────────

  public update(dt: number): void {
    if (this.destroyed) return;

    this.timer -= dt;
    if (this.timer <= 0) {
      this.destroyed = true;
      Engine.getEntities().destroyEntity(this.getOwner());
      return;
    }

    this.applyEffects(dt);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private applyEffects(dt: number): void {
    const damage = this.damagePerSecond * dt;

    for (const entity of Engine.getEntities().getAllEntities()) {
      const ec = entity.getComponent('enemy_controller') as EnemyControllerComponent | null;
      if (!ec) continue;

      const tc = entity.getComponent('transform') as TransformComponent | null;
      if (!tc) continue;

      const pos = tc.getTransform().getWorldPosition() as vec3;
      if (vec3.distance(this.center, pos) > this.radius) continue;

      // Continuous light damage
      entity.sendMsg(Msg.damage({ amount: damage, instigator: null }));

      // Notify bestiality system — small proportional gain per enemy hit
      BestialitySystem.notify(damage * 0.5);

      // Slow — re-affirm each frame so removal is instant when entity exits
      ec.applySlowEffect(this.slowFactor, dt * 2);
    }
  }

  public renderDebug(): void {}
}
