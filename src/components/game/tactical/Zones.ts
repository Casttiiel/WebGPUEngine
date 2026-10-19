import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Entity } from '../../../core/ecs/Entity';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import type { UnitComponent } from './UnitComponent';
import { groundHeightAt } from './TacticalQueries';

/**
 * Burbuja de bendaleo (GDD §10.2): un círculo fijo en el suelo donde el tiempo va rápido.
 *  - Quien acaba su turno dentro juega otro turno seguido (uno extra por ronda).
 *  - Ningún proyectil cruza el borde (ni hacia dentro ni hacia fuera).
 *  - Dura unas rondas y se rompe si quien la creó sale de ella.
 * Las reglas de turnos las aplica EncounterComponent; aquí están las burbujas, la geometría y
 * su decal.
 */
export interface TimeBubble {
  caster: UnitComponent;
  center: vec3;
  radius: number;
  /** Ronda del combate en la que desaparece. */
  untilRound: number;
  /** Ronda en la que cada unidad ha jugado ya su turno extra. */
  extraTurns: Map<UnitComponent, number>;
  visual: Entity | null;
}

const DECAL_PREFAB = 'tactical/zone_bendalloy.prefab';

export class Zones {
  private static bubbles: TimeBubble[] = [];

  public static getAll(): readonly TimeBubble[] {
    return this.bubbles;
  }

  public static add(
    caster: UnitComponent,
    center: vec3,
    radius: number,
    untilRound: number,
  ): TimeBubble {
    const bubble: TimeBubble = {
      caster,
      center: vec3.clone(center),
      radius,
      untilRound,
      extraTurns: new Map(),
      visual: null,
    };
    this.bubbles.push(bubble);
    const ground = groundHeightAt(center[0]!, center[2]!, center[1]! + 0.5) ?? center[1]!;
    void Loader.spawnFromJSON({ prefab: DECAL_PREFAB, components: {} } as EntityDataType).then(
      (e) => {
        if (!this.bubbles.includes(bubble)) {
          Engine.getEntities().destroyEntity(e);
          return;
        }
        const t = (e.getComponent('transform') as TransformComponent | null)?.getTransform();
        t?.setLocalPosition(vec3.fromValues(center[0]!, ground, center[2]!));
        t?.setLocalScale(vec3.fromValues(radius * 2, 0.8, radius * 2));
        bubble.visual = e;
      },
    );
    return bubble;
  }

  public static remove(bubble: TimeBubble): void {
    if (bubble.visual) Engine.getEntities().destroyEntity(bubble.visual);
    bubble.visual = null;
    this.bubbles = this.bubbles.filter((b) => b !== bubble);
  }

  public static clear(): void {
    for (const b of [...this.bubbles]) this.remove(b);
  }

  /** ¿Está el punto (pies) dentro de la burbuja? */
  public static contains(bubble: TimeBubble, point: vec3): boolean {
    return Math.hypot(point[0]! - bubble.center[0]!, point[2]! - bubble.center[2]!) < bubble.radius;
  }

  /** La burbuja en la que está la unidad (null: ninguna). */
  public static containing(unit: UnitComponent): TimeBubble | null {
    const feet = unit.getFeetPosition(vec3.create());
    return this.bubbles.find((b) => this.contains(b, feet)) ?? null;
  }

  /** La burbuja que ha creado `unit` (null: ninguna). */
  public static ownedBy(unit: UnitComponent): TimeBubble | null {
    return this.bubbles.find((b) => b.caster === unit) ?? null;
  }

  /**
   * Metros que se pueden recorrer por `points` sin salir de la burbuja (dejando `margin` m
   * hasta el borde). Infinity si el camino no sale.
   */
  public static lengthInside(bubble: TimeBubble, points: vec3[], margin = 0.35): number {
    const limit = Math.max(0, bubble.radius - margin);
    const p = vec3.create();
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const segment = vec3.distance(a, b);
      const steps = Math.max(1, Math.ceil(segment / 0.1));
      for (let k = 1; k <= steps; k++) {
        vec3.lerp(p, a, b, k / steps);
        const d = Math.hypot(p[0]! - bubble.center[0]!, p[2]! - bubble.center[2]!);
        if (d > limit) return length + (segment * (k - 1)) / steps;
      }
      length += segment;
    }
    return Infinity;
  }

  /** ¿Un proyectil de `a` a `b` cruza el borde de alguna burbuja (uno dentro y otro fuera)? */
  public static blocksProjectile(a: vec3, b: vec3): boolean {
    return this.bubbles.some((z) => this.contains(z, a) !== this.contains(z, b));
  }

  /**
   * Distancia a la que una línea desde `origin` en `dir` (horizontal, normalizada) cruza por
   * primera vez el borde de una burbuja; `max` si no lo cruza antes.
   */
  public static borderDistance(origin: vec3, dir: vec3, max: number): number {
    let best = max;
    for (const z of this.bubbles) {
      const ox = origin[0]! - z.center[0]!;
      const oz = origin[2]! - z.center[2]!;
      // |o + t·d|² = r²  →  t² + 2(o·d)t + |o|² − r² = 0
      const b = ox * dir[0]! + oz * dir[2]!;
      const c = ox * ox + oz * oz - z.radius * z.radius;
      const disc = b * b - c;
      if (disc < 0) continue;
      const s = Math.sqrt(disc);
      for (const t of [-b - s, -b + s]) if (t > 1e-3 && t < best) best = t;
    }
    return best;
  }
}
