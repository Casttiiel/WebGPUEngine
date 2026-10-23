import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Entity } from '../../../core/ecs/Entity';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import type { UnitComponent } from './UnitComponent';
import { groundHeightAt } from './TacticalQueries';

const DECAL_PREFAB = 'tactical/zone_copper.prefab';

/**
 * Nube de cobre (GDD §10.3): un círculo fijo en el suelo. Los del bando de quien la lanzó que
 * estén dentro no pueden ser objetivo de la alomancia de los rivales lanzada desde fuera
 * (empujes, tirones, emociones, cromo, bronce). Dura hasta el turno de quien la lanzó en
 * `untilRound` (o la ronda siguiente, si ha caído). Las reglas las aplica EncounterComponent;
 * aquí están las nubes, la geometría y su decal.
 */
export interface CopperCloud {
  caster: UnitComponent;
  center: vec3;
  radius: number;
  untilRound: number;
  visual: Entity | null;
}

export class CopperClouds {
  private static clouds: CopperCloud[] = [];

  public static getAll(): readonly CopperCloud[] {
    return this.clouds;
  }

  public static add(
    caster: UnitComponent,
    center: vec3,
    radius: number,
    untilRound: number,
  ): CopperCloud {
    const cloud: CopperCloud = { caster, center: vec3.clone(center), radius, untilRound, visual: null };
    this.clouds.push(cloud);
    const ground = groundHeightAt(center[0]!, center[2]!, center[1]! + 0.5) ?? center[1]!;
    void Loader.spawnFromJSON({ prefab: DECAL_PREFAB, components: {} } as EntityDataType).then(
      (e) => {
        if (!this.clouds.includes(cloud)) {
          Engine.getEntities().destroyEntity(e);
          return;
        }
        const t = (e.getComponent('transform') as TransformComponent | null)?.getTransform();
        t?.setLocalPosition(vec3.fromValues(center[0]!, ground, center[2]!));
        t?.setLocalScale(vec3.fromValues(radius * 2, 0.8, radius * 2));
        cloud.visual = e;
      },
    );
    return cloud;
  }

  /** Quita las nubes que cumplan `predicate` (todas sin él). */
  public static clear(predicate: (c: CopperCloud) => boolean = () => true): void {
    for (const c of this.clouds.filter(predicate)) {
      if (c.visual) Engine.getEntities().destroyEntity(c.visual);
      c.visual = null;
    }
    this.clouds = this.clouds.filter((c) => !predicate(c));
  }

  public static contains(cloud: CopperCloud, point: vec3): boolean {
    return Math.hypot(point[0]! - cloud.center[0]!, point[2]! - cloud.center[2]!) < cloud.radius;
  }

  /**
   * ¿Protege una nube a `unit` de la alomancia de `caster`? Sí si `unit` está dentro de una nube
   * de su bando, `caster` es de otro bando y lanza desde fuera de esa nube.
   */
  public static shields(unit: UnitComponent, caster: UnitComponent): boolean {
    if (unit.getFaction() === caster.getFaction() || this.clouds.length === 0) return false;
    const feet = unit.getFeetPosition(vec3.create());
    const from = caster.getFeetPosition(vec3.create());
    return this.clouds.some(
      (c) =>
        c.caster.getFaction() === unit.getFaction() &&
        this.contains(c, feet) &&
        !this.contains(c, from),
    );
  }
}
