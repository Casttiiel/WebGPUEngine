import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { Entity } from '../../../core/ecs/Entity';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import { UnitComponent } from './UnitComponent';
import { groundHeightAt } from './TacticalQueries';

const DECAL_PREFAB = 'tactical/zone_resonance.prefab';

/**
 * Resonancia de ettmetal (GDD §10.4): el aro en el suelo alrededor de quien la emite, para
 * ver quién queda dentro. La regla (+POT a los aliados cercanos) está en UnitComponent
 * (getAttributes); aquí solo el decal, que sigue a la unidad en combate.
 */
export class ResonanceAuras {
  /** Decal de cada emisor (null: cargándose). */
  private static visuals = new Map<UnitComponent, Entity | null>();
  private static readonly tmp = vec3.create();

  /** Pone los aros al día: uno por emisor vivo mientras `shown`; si no, ninguno. */
  public static update(shown: boolean): void {
    const wanted = new Set<UnitComponent>();
    if (shown) {
      for (const u of UnitComponent.getAll()) if (u.getResonance() && u.isAlive()) wanted.add(u);
    }
    for (const [unit, visual] of this.visuals) {
      if (wanted.has(unit)) continue;
      if (visual) Engine.getEntities().destroyEntity(visual);
      this.visuals.delete(unit);
    }
    for (const unit of wanted) {
      if (!this.visuals.has(unit)) {
        this.spawn(unit);
        continue;
      }
      const visual = this.visuals.get(unit);
      if (visual) this.place(unit, visual);
    }
  }

  public static clear(): void {
    this.update(false);
  }

  private static spawn(unit: UnitComponent): void {
    this.visuals.set(unit, null);
    void Loader.spawnFromJSON({ prefab: DECAL_PREFAB, components: {} } as EntityDataType).then(
      (e) => {
        // Ya no hace falta (se acabó el combate o cayó mientras cargaba).
        if (!this.visuals.has(unit) || this.visuals.get(unit) !== null) {
          Engine.getEntities().destroyEntity(e);
          return;
        }
        this.visuals.set(unit, e);
        this.place(unit, e);
      },
    );
  }

  /** En sus pies, del tamaño del aura (hasta el borde de quien está dentro: + su radio). */
  private static place(unit: UnitComponent, visual: Entity): void {
    const aura = unit.getResonance()!;
    const feet = unit.getFeetPosition(this.tmp);
    const ground = groundHeightAt(feet[0]!, feet[2]!, feet[1]! + 0.5) ?? feet[1]!;
    const radius = aura.radius + unit.getCapsuleRadius();
    const t = (visual.getComponent('transform') as TransformComponent | null)?.getTransform();
    t?.setLocalPosition(vec3.fromValues(feet[0]!, ground, feet[2]!));
    t?.setLocalScale(vec3.fromValues(radius * 2, 0.8, radius * 2));
  }
}
