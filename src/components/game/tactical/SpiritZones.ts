import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Entity } from '../../../core/ecs/Entity';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import { UnitComponent } from './UnitComponent';
import { PropComponent } from './PropComponent';
import { groundHeightAt } from './TacticalQueries';

/**
 * Zonas espirituales (GDD §8): mentes de metal espirituales que se liberan en un área. Afectan
 * a todos los que están dentro, de los dos bandos, y reutilizan reglas que ya existen:
 *  - fortune (cromo, Fortuna): quien ataca desde dentro tiene +10 % de crítico.
 *  - connection (duraluminio, Conexión): un estado aplicado a una unidad de dentro se copia a
 *    las de su bando que también estén dentro.
 *  - investiture (niquelsil, Investidura): las habilidades lanzadas desde dentro hacen +50 %
 *    (el multiplicador del duraluminio).
 *
 * De dónde salen:
 *  - Liberar mente espiritual (Artificiera): una a la vez por lanzador; caduca al empezar su
 *    turno en `untilRound` (como las granadas: todos juegan los mismos turnos con ella).
 *  - Relicarios: props metálicos que la emiten mientras están enteros; la zona va con ellos
 *    (empujarlos o atraerlos la mueve). Al romperse, la sueltan de golpe donde estaban hasta
 *    la ronda siguiente.
 * Las reglas las aplican CombatRules (crítico) y EncounterComponent; aquí están las zonas, su
 * geometría y su decal.
 */
export type SpiritKind = 'fortune' | 'connection' | 'investiture';

export interface SpiritZone {
  kind: SpiritKind;
  center: vec3;
  radius: number;
  /** Quien la liberó (Liberar mente espiritual); null: un relicario. */
  caster: UnitComponent | null;
  /** El relicario que la emite (la zona le sigue); null: fija. */
  relic: UnitComponent | null;
  /** Ronda en la que caduca (Infinity: la de un relicario entero). */
  untilRound: number;
  visual: Entity | null;
}

/** Fortuna: probabilidad de crítico que se suma (0-1). */
export const FORTUNE_CRIT = 0.1;
/** Investidura: multiplicador del efecto de las habilidades. */
export const INVESTITURE_POWER = 1.5;

export const SPIRIT_NAME: Record<SpiritKind, string> = {
  fortune: 'Fortuna',
  connection: 'Conexión',
  investiture: 'Investidura',
};

const DECAL_PREFAB: Record<SpiritKind, string> = {
  fortune: 'tactical/zone_fortune.prefab',
  connection: 'tactical/zone_connection.prefab',
  investiture: 'tactical/zone_investiture.prefab',
};

/** Altura del decal (m): cubre desniveles pequeños. */
const DECAL_HEIGHT = 0.8;

export class SpiritZones {
  private static zones: SpiritZone[] = [];

  public static getAll(): readonly SpiritZone[] {
    return this.zones;
  }

  public static add(
    kind: SpiritKind,
    center: vec3,
    radius: number,
    options: { caster?: UnitComponent | null; relic?: UnitComponent | null; untilRound?: number },
  ): SpiritZone {
    const zone: SpiritZone = {
      kind,
      center: vec3.clone(center),
      radius,
      caster: options.caster ?? null,
      relic: options.relic ?? null,
      untilRound: options.untilRound ?? Infinity,
      visual: null,
    };
    this.zones.push(zone);
    void Loader.spawnFromJSON({
      prefab: DECAL_PREFAB[kind],
      components: {},
    } as EntityDataType).then((e) => {
      if (!this.zones.includes(zone)) {
        Engine.getEntities().destroyEntity(e);
        return;
      }
      zone.visual = e;
      this.placeVisual(zone);
    });
    return zone;
  }

  public static remove(zone: SpiritZone): void {
    if (zone.visual) Engine.getEntities().destroyEntity(zone.visual);
    zone.visual = null;
    this.zones = this.zones.filter((z) => z !== zone);
  }

  /** Quita las zonas que cumplan `filter` (todas sin él). */
  public static clear(filter: (z: SpiritZone) => boolean = () => true): void {
    for (const z of this.zones.filter(filter)) this.remove(z);
  }

  /** La zona que ha liberado `unit` (una a la vez). */
  public static ownedBy(unit: UnitComponent): SpiritZone | null {
    return this.zones.find((z) => z.caster === unit) ?? null;
  }

  /** ¿Está el punto (pies) dentro de la zona? */
  public static contains(zone: SpiritZone, point: vec3): boolean {
    return (
      Math.hypot(point[0]! - zone.center[0]!, point[2]! - zone.center[2]!) < zone.radius &&
      Math.abs(point[1]! - zone.center[1]!) < 2
    );
  }

  /** La zona de ese tipo que contiene el punto (null: ninguna). */
  public static at(point: vec3, kind: SpiritKind): SpiritZone | null {
    return this.zones.find((z) => z.kind === kind && this.contains(z, point)) ?? null;
  }

  /** La zona de ese tipo en la que está la unidad (null: ninguna). Los objetos no cuentan. */
  public static containing(unit: UnitComponent, kind: SpiritKind): SpiritZone | null {
    if (PropComponent.of(unit.getOwner())) return null;
    return this.at(unit.getFeetPosition(vec3.create()), kind);
  }

  /** Fortuna: crítico extra (0-1) de quien ataca desde `feet` (default: donde está). */
  public static critBonus(unit: UnitComponent, feet?: vec3): number {
    const p = feet ?? unit.getFeetPosition(vec3.create());
    return this.at(p, 'fortune') ? FORTUNE_CRIT : 0;
  }

  /** Investidura: multiplicador de las habilidades lanzadas desde donde está. */
  public static powerFor(unit: UnitComponent): number {
    return this.containing(unit, 'investiture') ? INVESTITURE_POWER : 1;
  }

  /**
   * Conexión: con quién comparte un estado aplicado a `unit` (los de su bando dentro de la
   * misma zona; sin `unit` ni objetos). Vacío si no está en ninguna.
   */
  public static connectedTo(unit: UnitComponent): UnitComponent[] {
    const zone = this.containing(unit, 'connection');
    if (!zone) return [];
    const p = vec3.create();
    return UnitComponent.getAll().filter(
      (u) =>
        u !== unit &&
        u.isAlive() &&
        u.getFaction() === unit.getFaction() &&
        !PropComponent.of(u.getOwner()) &&
        this.contains(zone, u.getFeetPosition(p)),
    );
  }

  /**
   * Cada frame: cada relicario entero tiene su zona, que va con él; la de uno roto (o
   * desaparecido) se quita (la suelta EncounterComponent al romperse).
   */
  public static syncRelics(): void {
    for (const z of [...this.zones]) {
      if (z.relic && (!z.relic.isAlive() || !UnitComponent.getAll().includes(z.relic))) {
        this.remove(z);
      }
    }
    const p = vec3.create();
    for (const u of UnitComponent.getAll()) {
      const relic = PropComponent.of(u.getOwner())?.getRelic();
      if (!relic || !u.isAlive()) continue;
      const zone =
        this.zones.find((z) => z.relic === u) ??
        this.add(relic.zone, u.getFeetPosition(p), relic.radius, { relic: u });
      u.getFeetPosition(p);
      if (vec3.squaredDistance(p, zone.center) > 1e-6) {
        vec3.copy(zone.center, p);
        this.placeVisual(zone);
      }
    }
  }

  private static placeVisual(zone: SpiritZone): void {
    const t = (zone.visual?.getComponent('transform') as TransformComponent | null)?.getTransform();
    if (!t) return;
    const c = zone.center;
    const ground = groundHeightAt(c[0]!, c[2]!, c[1]! + 0.5) ?? c[1]!;
    t.setLocalPosition(vec3.fromValues(c[0]!, ground, c[2]!));
    t.setLocalScale(vec3.fromValues(zone.radius * 2, DECAL_HEIGHT, zone.radius * 2));
  }
}
