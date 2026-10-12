import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import type { SurfaceType } from './Surfaces';
import type { DamageValue } from './Dice';

export interface PropExplosion {
  /** Radio de la explosión (m, hasta el borde de cada unidad). */
  radius: number;
  damage: number;
  /** Superficie que deja (p.ej. fuego). */
  surface?: SurfaceType;
  surfaceRadius?: number;
}

export type PropComponentDataType = Readonly<{
  /** Se puede empujar (acción adicional). Default false. */
  pushable?: boolean;
  /** Distancia máxima que recorre al empujarlo (m). Default 3. */
  pushDistance?: number;
  /** Se puede lanzar (acción). Default: lo mismo que pushable. */
  throwable?: boolean;
  /** Daño al golpear a una unidad (empujado o lanzado); el objeto recibe el mismo. Default "1d6+2". */
  impactDamage?: DamageValue;
  /** Explota al destruirse (vida a 0: un ataque, el fuego, otra explosión). */
  explosive?: PropExplosion;
}>;

/**
 * PropComponent — objeto del entorno con el que se puede interactuar (barriles, cajas).
 *
 * El objeto es además una unidad neutral (UnitComponent + HealthComponent): así se puede
 * apuntar, atacar, bloquea caminos y tiene vida, con las mismas reglas que todo lo demás.
 * Aquí solo están sus propiedades de objeto; las reglas (empujar, lanzar, impactos, explotar) las aplica
 * EncounterComponent.
 */
export class PropComponent extends Component {
  private pushable = false;
  private pushDistance = 3;
  private throwable = false;
  private impactDamage: DamageValue = '1d6+2';
  private explosive: PropExplosion | null = null;

  public load(data: PropComponentDataType): void {
    this.pushable = data.pushable ?? false;
    this.pushDistance = data.pushDistance ?? this.pushDistance;
    this.throwable = data.throwable ?? this.pushable;
    this.impactDamage = data.impactDamage ?? this.impactDamage;
    this.explosive = data.explosive ? { ...data.explosive } : null;
  }

  public update(_dt: number): void {}

  public isPushable(): boolean {
    return this.pushable;
  }

  public getPushDistance(): number {
    return this.pushDistance;
  }

  public isThrowable(): boolean {
    return this.throwable;
  }

  public getImpactDamage(): DamageValue {
    return this.impactDamage;
  }

  public getExplosion(): PropExplosion | null {
    return this.explosive;
  }

  public static of(entity: Entity): PropComponent | null {
    return entity.getComponent('tactical_prop') as PropComponent | null;
  }
}
