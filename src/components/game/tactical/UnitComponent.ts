import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../core/TransformComponent';

export type UnitFaction = 'party' | 'enemy' | 'neutral';

export type UnitComponentDataType = Readonly<{
  /** Bando de la unidad. Default: 'neutral'. */
  faction?: UnitFaction;
  /** Nombre visible (UI). Default: nombre de la entidad. */
  displayName?: string;
}>;

/**
 * UnitComponent — marca una entidad como unidad del juego táctico (miembro de la party,
 * enemigo o neutral). Es la base sobre la que se construirán party, turnos y combate;
 * de momento la cámara táctica la usa para enfocar y seguir unidades.
 */
export class UnitComponent extends Component {
  private faction: UnitFaction = 'neutral';
  private displayName: string | null = null;

  public load(data: UnitComponentDataType): void {
    this.faction = data.faction ?? 'neutral';
    this.displayName = data.displayName ?? null;
  }

  public update(_dt: number): void {}

  public getFaction(): UnitFaction {
    return this.faction;
  }

  public getDisplayName(): string {
    return this.displayName ?? this.getOwner().getName();
  }

  /** Posición de mundo del pivote de la unidad (centro de la cápsula). */
  public getPosition(out: vec3 = vec3.create()): vec3 {
    const transform = this.getOwner().getComponent('transform') as TransformComponent | null;
    if (!transform) return vec3.zero(out);
    return vec3.copy(out, transform.getTransform().getWorldPosition());
  }

  /** Todas las unidades de la escena: primero la party, después enemigos y neutrales. */
  public static getAll(): UnitComponent[] {
    const list = (Engine.getEntities().getObjectManagerByName('unit')?.getList() ??
      []) as UnitComponent[];
    const order: Record<UnitFaction, number> = { party: 0, enemy: 1, neutral: 2 };
    return [...list].sort((a, b) => order[a.faction] - order[b.faction]);
  }
}
