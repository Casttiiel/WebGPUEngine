import { quat, vec3 } from 'gl-matrix';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import { TransformComponent } from '../../core/TransformComponent';
import { RenderComponent } from '../../render/RenderComponent';
import { groundHeightAt } from './TacticalQueries';

const UP = vec3.fromValues(0, 1, 0);

/**
 * GroundMarker — un decal (prefab) creado en runtime que se coloca en el suelo bajo un
 * punto: anillos de selección y de hover. Se crea fuera de la escena a propósito: así no
 * lo agrupa InstanceManager (los decals no tienen técnica instanciada).
 */
export class GroundMarker {
  private entity: Entity | null = null;
  private spawning: Promise<void> | null = null;
  private visible = false;
  /** Escala del prefab (la altura de proyección del decal se conserva al orientarlo). */
  private baseScale: vec3 | null = null;
  private readonly pos = vec3.create();
  private readonly rot = quat.create();
  private readonly scale = vec3.create();

  constructor(private readonly prefab: string) {}

  public spawn(): Promise<void> {
    this.spawning ??= Loader.spawnFromJSON({ prefab: this.prefab, components: {} }).then((e) => {
      this.entity = e;
      const t = (e.getComponent('transform') as TransformComponent | null)?.getTransform();
      this.baseScale = t ? vec3.clone(t.getLocalScale()) : null;
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

  /**
   * Como showAt, girado `yaw` rad sobre la vertical (su +Z apunta hacia allí) y con
   * `width` × `length` m en el suelo.
   */
  public showOriented(point: vec3, yaw: number, width: number, length: number): void {
    if (!this.entity) return;
    this.showAt(point);
    const t = (this.entity.getComponent('transform') as TransformComponent | null)?.getTransform();
    if (!t) return;
    t.setLocalRotation(quat.setAxisAngle(this.rot, UP, yaw));
    t.setLocalScale(vec3.set(this.scale, width, this.baseScale?.[1] ?? 1, length));
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
