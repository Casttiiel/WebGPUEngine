import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Entity } from '../../../core/ecs/Entity';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import type { UnitComponent } from './UnitComponent';
import { groundHeightAt } from './TacticalQueries';

/**
 * Burbujas de tiempo (GDD §10.2, §10.4): un círculo fijo en el suelo.
 *  - fast (bendaleo): quien acaba su turno dentro juega otro seguido (uno extra por ronda).
 *    Ningún proyectil cruza el borde (ni hacia dentro ni hacia fuera).
 *  - slow (cadmio): quien empieza su turno dentro lo pierde (uno por burbuja).
 *  - En las dos, nadie sale andando. Duran unas rondas; la anclada al lanzador (la del
 *    Deslizador) se rompe si sale de ella y se puede cerrar; la lanzada (una granada), no.
 * Las reglas de turnos las aplica EncounterComponent; aquí están las burbujas, la geometría y
 * su decal.
 */
export type BubbleTime = 'fast' | 'slow';

export interface TimeBubble {
  caster: UnitComponent;
  center: vec3;
  radius: number;
  time: BubbleTime;
  /** Centrada en el lanzador: se rompe si sale y la puede cerrar. */
  anchored: boolean;
  /**
   * Ronda del combate en la que desaparece: al empezarla (anclada) o al empezar en ella el
   * turno de quien la lanzó (lanzada: así todos juegan un turno con ella).
   */
  untilRound: number;
  /** fast: ronda en la que cada unidad ha jugado ya su turno extra. */
  extraTurns: Map<UnitComponent, number>;
  /** slow: unidades que ya han perdido su turno en esta burbuja. */
  lostTurns: Set<UnitComponent>;
  visual: Entity | null;
}

const DECAL_PREFAB: Record<BubbleTime, string> = {
  fast: 'tactical/zone_bendalloy.prefab',
  slow: 'tactical/zone_cadmium.prefab',
};

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
    time: BubbleTime = 'fast',
    anchored = true,
  ): TimeBubble {
    const bubble: TimeBubble = {
      caster,
      center: vec3.clone(center),
      radius,
      time,
      anchored,
      untilRound,
      extraTurns: new Map(),
      lostTurns: new Set(),
      visual: null,
    };
    this.bubbles.push(bubble);
    const ground = groundHeightAt(center[0]!, center[2]!, center[1]! + 0.5) ?? center[1]!;
    void Loader.spawnFromJSON({
      prefab: DECAL_PREFAB[time],
      components: {},
    } as EntityDataType).then((e) => {
      if (!this.bubbles.includes(bubble)) {
        Engine.getEntities().destroyEntity(e);
        return;
      }
      const t = (e.getComponent('transform') as TransformComponent | null)?.getTransform();
      t?.setLocalPosition(vec3.fromValues(center[0]!, ground, center[2]!));
      t?.setLocalScale(vec3.fromValues(radius * 2, 0.8, radius * 2));
      bubble.visual = e;
    });
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

  /** La burbuja en la que está la unidad, de ese tiempo si se pide (null: ninguna). */
  public static containing(unit: UnitComponent, time?: BubbleTime): TimeBubble | null {
    const feet = unit.getFeetPosition(vec3.create());
    return this.bubbles.find((b) => (!time || b.time === time) && this.contains(b, feet)) ?? null;
  }

  /** La burbuja anclada que ha creado `unit` (la que puede cerrar; null: ninguna). */
  public static ownedBy(unit: UnitComponent): TimeBubble | null {
    return this.bubbles.find((b) => b.anchored && b.caster === unit) ?? null;
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

  /**
   * ¿Un proyectil de `a` a `b` cruza el borde de alguna burbuja de bendaleo (uno dentro y otro
   * fuera)? El de cadmio no los para.
   */
  public static blocksProjectile(a: vec3, b: vec3): boolean {
    return this.bubbles.some(
      (z) => z.time === 'fast' && this.contains(z, a) !== this.contains(z, b),
    );
  }

  /**
   * Distancia a la que una línea desde `origin` en `dir` (horizontal, normalizada) cruza por
   * primera vez el borde de una burbuja de bendaleo; `max` si no lo cruza antes.
   */
  public static borderDistance(origin: vec3, dir: vec3, max: number): number {
    let best = max;
    for (const z of this.bubbles) {
      if (z.time !== 'fast') continue;
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
