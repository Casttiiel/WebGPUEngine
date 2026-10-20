import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import type { SurfaceType } from './Surfaces';
import type { SpiritKind } from './SpiritZones';

/** Relicario (GDD §8): emite una zona espiritual a su alrededor mientras está entero. */
export interface PropRelic {
  zone: SpiritKind;
  radius: number;
}

export interface PropExplosion {
  /** Radio de la explosión (m, hasta el borde de cada unidad). */
  radius: number;
  damage: number;
  /** Superficie que deja (p.ej. fuego). */
  surface?: SurfaceType;
  surfaceRadius?: number;
}

/**
 * Tamaño (GDD §5). Pequeño: cuchillos, clavos, monedas (munición del tirón y el empuje; se
 * lanzan a mano; se rompen al usarlos, y se colocan encima de cajas y muretes, no en el suelo).
 * Grande: cajas, barriles, carros (solo con alomancia o la fuerza del peltre).
 */
export type PropSize = 'small' | 'large';

/** Daño base del impacto según el tamaño; se le suma POT (alomancia) o FUE (a mano, peltre). */
export const IMPACT_BASE: Record<PropSize, number> = { small: 6, large: 10 };

export type PropComponentDataType = Readonly<{
  /** Pequeño o Grande. Default 'large'. */
  size?: PropSize;
  /** De metal: se puede empujar y atraer con alomancia. Default false. */
  metallic?: boolean;
  /** Se rompe al golpear a una unidad, tenga la vida que tenga. Default true. Los Pequeños se
   *  rompen siempre al usarlos. */
  breakOnImpact?: boolean;
  /** Explota al destruirse (vida a 0: un ataque, el fuego, otra explosión). */
  explosive?: PropExplosion;
  /** Relicario: la zona espiritual que emite (y que suelta al romperse). */
  relic?: PropRelic;
}>;

/**
 * PropComponent — objeto del entorno con el que se puede interactuar (barriles, cajas,
 * cuchillos). No hay props anclados: lo que no se mueve es escenario estático.
 *
 * El objeto es además una unidad neutral (UnitComponent + HealthComponent): así se puede
 * apuntar, atacar, bloquea caminos y tiene vida, con las mismas reglas que todo lo demás.
 * Aquí solo están sus propiedades de objeto; las reglas (empujar, lanzar, impactos, explotar)
 * las aplica EncounterComponent.
 */
export class PropComponent extends Component {
  private size: PropSize = 'large';
  private metallic = false;
  private breakOnImpact = true;
  private explosive: PropExplosion | null = null;
  private relic: PropRelic | null = null;

  public load(data: PropComponentDataType): void {
    this.size = data.size ?? this.size;
    this.metallic = data.metallic ?? false;
    this.breakOnImpact = data.breakOnImpact ?? this.breakOnImpact;
    this.explosive = data.explosive ? { ...data.explosive } : null;
    this.relic = data.relic ? { ...data.relic } : null;
  }

  public update(_dt: number): void {}

  public getSize(): PropSize {
    return this.size;
  }

  public isSmall(): boolean {
    return this.size === 'small';
  }

  public isMetallic(): boolean {
    return this.metallic;
  }

  /** Daño base de su impacto (sin el atributo de quien lo lanza). */
  public getImpactBase(): number {
    return IMPACT_BASE[this.size];
  }

  public breaksOnImpact(): boolean {
    return this.breakOnImpact;
  }

  public getExplosion(): PropExplosion | null {
    return this.explosive;
  }

  public getRelic(): PropRelic | null {
    return this.relic;
  }

  public static of(entity: Entity): PropComponent | null {
    return entity.getComponent('tactical_prop') as PropComponent | null;
  }
}
