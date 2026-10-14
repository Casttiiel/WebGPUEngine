import { vec3 } from 'gl-matrix';
import { Component } from '../../../core/ecs/Component';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import { groundHeightAt } from './TacticalQueries';

/**
 * fire: quema (daño) al entrar y al empezar el turno dentro. Se apaga tras unas rondas.
 * oil:  charco inflamable: el fuego o una explosión lo convierten en fuego.
 */
export type SurfaceType = 'fire' | 'oil';

export type SurfaceComponentDataType = Readonly<{
  type: SurfaceType;
  /** Radio (m). Default 1.5. */
  radius?: number;
}>;

/**
 * SurfaceComponent — superficie colocada en la escena (p.ej. un charco de aceite). Solo
 * declara tipo, posición (su transform) y radio; Surfaces la crea y la gestiona.
 */
export class SurfaceComponent extends Component {
  private type: SurfaceType = 'oil';
  private radius = 1.5;

  public load(data: SurfaceComponentDataType): void {
    this.type = data.type;
    this.radius = data.radius ?? this.radius;
  }

  public update(_dt: number): void {}

  public getType(): SurfaceType {
    return this.type;
  }

  public getRadius(): number {
    return this.radius;
  }

  public getPosition(out: vec3 = vec3.create()): vec3 {
    const t = this.getOwner().getComponent('transform') as TransformComponent | null;
    return t ? vec3.copy(out, t.getTransform().getWorldPosition()) : vec3.zero(out);
  }

  public static getAll(): SurfaceComponent[] {
    return (Engine.getEntities().getObjectManagerByName('tactical_surface')?.getList() ??
      []) as SurfaceComponent[];
  }
}

export interface Surface {
  type: SurfaceType;
  center: vec3;
  radius: number;
  /** Rondas que le quedan (fuego). Infinity: permanente (aceite). */
  rounds: number;
  visuals: Entity[];
}

/** Rondas que dura un fuego. */
const FIRE_ROUNDS = 3;
/** Fuera de combate una "ronda" son estos segundos (el fuego se apaga igual). */
const SECONDS_PER_ROUND = 6;
const DECAL_PREFAB: Record<SurfaceType, string> = {
  fire: 'tactical/surface_fire.prefab',
  oil: 'tactical/surface_oil.prefab',
};
const FIRE_PARTICLES = 'tactical/fire_particles.prefab';
const EXPLOSION_PREFAB = 'tactical/explosion.prefab';
const EXPLOSION_LIFETIME = 1.5;

/**
 * Surfaces — las superficies del encuentro (fuego, aceite): dónde están, qué hay en cada
 * punto, su duración y sus visuales (decal en el suelo + partículas para el fuego).
 *
 * Las reglas de juego (quemar a quien entra) las aplica EncounterComponent preguntando
 * fireAt(). Aquí: crear, prender el aceite que toca el fuego, apagar y reiniciar.
 */
export class Surfaces {
  private surfaces: Surface[] = [];
  private initialized = false;
  private roundTimer = SECONDS_PER_ROUND;
  private effects: { entity: Entity | null; time: number }[] = [];

  /** Crea las superficies declaradas en la escena (SurfaceComponent). Idempotente. */
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const s of SurfaceComponent.getAll()) {
      this.add(s.getType(), s.getPosition(), s.getRadius());
    }
  }

  /** Vuelve a las superficies de la escena (reiniciar el encuentro). */
  public reset(): void {
    for (const s of this.surfaces) this.destroyVisuals(s);
    this.surfaces = [];
    this.initialized = false;
    this.init();
  }

  public getAll(): readonly Surface[] {
    return this.surfaces;
  }

  /** Añade una superficie. Si es fuego, prende el aceite que toque. */
  public add(type: SurfaceType, center: vec3, radius: number): void {
    const surface: Surface = {
      type,
      center: vec3.clone(center),
      radius,
      rounds: type === 'fire' ? FIRE_ROUNDS : Infinity,
      visuals: [],
    };
    this.surfaces.push(surface);
    this.spawnVisuals(surface);
    if (type === 'fire') this.igniteAround(surface.center, radius);
  }

  /** Prende el aceite que toque el círculo (explosión, fuego nuevo). En cadena. */
  public igniteAround(center: vec3, radius: number): void {
    for (const s of [...this.surfaces]) {
      if (s.type !== 'oil') continue;
      if (horizontalDistance(s.center, center) > s.radius + radius) continue;
      this.remove(s);
      this.add('fire', s.center, s.radius);
    }
  }

  /** ¿Hay fuego en este punto (pies de una unidad, con su radio)? */
  public fireAt(point: vec3, radius = 0): boolean {
    return this.surfaces.some(
      (s) => s.type === 'fire' && horizontalDistance(s.center, point) <= s.radius + radius * 0.5,
    );
  }

  /** Una ronda más de combate: el fuego se consume. */
  public onRound(): void {
    for (const s of [...this.surfaces]) {
      if (s.type !== 'fire') continue;
      s.rounds--;
      if (s.rounds <= 0) this.remove(s);
    }
  }

  /** Fuera de combate el fuego también se apaga (cada SECONDS_PER_ROUND cuenta una ronda). */
  public update(dt: number, inCombat: boolean): void {
    if (!inCombat) {
      this.roundTimer -= dt;
      if (this.roundTimer <= 0) {
        this.roundTimer = SECONDS_PER_ROUND;
        this.onRound();
      }
    }
    for (const e of this.effects) e.time -= dt;
    for (const e of this.effects.filter((x) => x.time <= 0 && x.entity)) {
      Engine.getEntities().destroyEntity(e.entity!);
    }
    this.effects = this.effects.filter((e) => e.time > 0 || !e.entity);
  }

  /** Efecto visual de una explosión (partículas que se destruyen solas). */
  public spawnExplosion(center: vec3): void {
    this.spawnEffect(EXPLOSION_PREFAB, center, EXPLOSION_LIFETIME);
  }

  /** Efecto de partículas de un solo uso (`prefab`) a `height` m sobre `point`, durante `lifetime` s. */
  public spawnEffect(prefab: string, point: vec3, lifetime: number, height = 0.6): void {
    const effect = { entity: null as Entity | null, time: lifetime };
    this.effects.push(effect);
    void spawn({
      prefab,
      components: { transform: { position: [point[0]!, point[1]! + height, point[2]!] } },
    }).then((e) => (effect.entity = e));
  }

  private remove(surface: Surface): void {
    this.destroyVisuals(surface);
    this.surfaces = this.surfaces.filter((s) => s !== surface);
  }

  private spawnVisuals(surface: Surface): void {
    const c = surface.center;
    const ground = groundHeightAt(c[0]!, c[2]!, c[1]! + 0.5) ?? c[1]!;
    const r = surface.radius;
    // Decal: la posición y la escala del prefab se combinan con las de la escena (suma /
    // producto), así que se colocan después de crearlo.
    const parts: { json: Parameters<typeof spawn>[0]; place?: (e: Entity) => void }[] = [
      {
        json: { prefab: DECAL_PREFAB[surface.type], components: {} },
        place: (e) => {
          const t = (e.getComponent('transform') as TransformComponent | null)?.getTransform();
          t?.setLocalPosition(vec3.fromValues(c[0]!, ground, c[2]!));
          t?.setLocalScale(vec3.fromValues(r * 2, 0.8, r * 2));
        },
      },
    ];
    if (surface.type === 'fire') {
      parts.push({
        json: {
          prefab: FIRE_PARTICLES,
          components: {
            transform: { position: [c[0]!, ground + 0.05, c[2]!] },
            particle_system: { spawnRadius: [r * 0.8, 0.05, r * 0.8], emissionRate: 25 * r * r },
          },
        },
      });
    }
    for (const { json, place } of parts) {
      void spawn(json).then((e) => {
        place?.(e);
        // Si la superficie ya no existe (se apagó mientras cargaba), fuera.
        if (!this.surfaces.includes(surface)) Engine.getEntities().destroyEntity(e);
        else surface.visuals.push(e);
      });
    }
  }

  private destroyVisuals(surface: Surface): void {
    for (const e of surface.visuals) Engine.getEntities().destroyEntity(e);
    surface.visuals = [];
  }
}

/** Crea una entidad desde un prefab con overrides parciales (sin exigir componentes completos). */
function spawn(json: { prefab: string; components: Record<string, unknown> }): Promise<Entity> {
  return Loader.spawnFromJSON(json as unknown as EntityDataType);
}

function horizontalDistance(a: vec3, b: vec3): number {
  return Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
}
