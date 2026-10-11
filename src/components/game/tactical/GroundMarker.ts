import { vec3 } from 'gl-matrix';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import { TransformComponent } from '../../core/TransformComponent';
import { RenderComponent } from '../../render/RenderComponent';
import { groundHeightAt } from './TacticalQueries';

/**
 * GroundMarker — un decal (prefab) creado en runtime que se coloca en el suelo bajo un
 * punto: anillos de selección y de hover. Se crea fuera de la escena a propósito: así no
 * lo agrupa InstanceManager (los decals no tienen técnica instanciada).
 */
export class GroundMarker {
  private entity: Entity | null = null;
  private spawning: Promise<void> | null = null;
  private visible = false;
  private readonly pos = vec3.create();

  constructor(private readonly prefab: string) {}

  public spawn(): Promise<void> {
    this.spawning ??= Loader.spawnFromJSON({ prefab: this.prefab, components: {} }).then((e) => {
      this.entity = e;
      this.setVisible(false);
    });
    return this.spawning;
  }

  /** Muestra el marcador en el suelo bajo `point` (p.ej. el centro de una unidad). */
  public showAt(point: vec3): void {
    if (!this.entity) return;
    const ground = groundHeightAt(point[0]!, point[2]!, point[1]! + 0.5) ?? point[1]!;
    vec3.set(this.pos, point[0]!, ground, point[2]!);
    const transform = this.entity.getComponent('transform') as TransformComponent | null;
    transform?.getTransform().setLocalPosition(this.pos);
    this.setVisible(true);
  }

  public hide(): void {
    this.setVisible(false);
  }

  public isVisible(): boolean {
    return this.visible;
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    (this.entity?.getComponent('render') as RenderComponent | null)?.setVisible(visible);
  }

  public destroy(): void {
    if (this.entity) Engine.getEntities().destroyEntity(this.entity);
    this.entity = null;
  }
}
