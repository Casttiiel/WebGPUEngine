import { quat, vec3 } from 'gl-matrix';
import { Entity } from '../../../core/ecs/Entity';
import { Engine } from '../../../core/engine/Engine';
import { Loader } from '../../../core/loaders/Loader';
import type { EntityDataType } from '../../../types/SceneData.type';
import { TransformComponent } from '../../core/TransformComponent';
import { ParticleSystemComponent } from '../../render/ParticleSystemComponent';
import { groundHeightAt } from './TacticalQueries';
import type { UnitComponent } from './UnitComponent';

const SPRAY_PREFAB = 'tactical/blood_spray.prefab';
const MIST_PREFAB = 'tactical/blood_mist.prefab';
const SPLAT_PREFAB = 'tactical/blood_splat.prefab';

/** Altura del golpe sobre el centro de la cápsula (el pecho). */
const CHEST_HEIGHT = 0.25;
/** Velocidad (m/s) del chorro en la dirección del golpe y hacia arriba. */
const SPRAY_SPEED = 6;
const SPRAY_LIFT = 1.6;
/** Segundos hasta que una mancha se seca y desaparece (edad 0 → 1); los charcos duran más. */
const SPLAT_LIFETIME = 90;
const POOL_LIFETIME = 180;
/** Manchas a la vez: al pasarse, la más vieja se apaga en RETIRE_TIME s. */
const MAX_SPLATS = 40;
const RETIRE_TIME = 1;
/** Lo que tardan las gotas en llegar al suelo: entonces aparece su mancha. */
const SPLAT_DELAY = 0.22;
/** La mancha llega extendiéndose: de SPREAD_FROM a su tamaño en SPREAD_TIME s. */
const SPREAD_FROM = 0.55;
const SPREAD_TIME = 0.2;
/** Charco al morir: cuándo empieza y lo que tarda en extenderse. */
const POOL_DELAY = 0.7;
const POOL_SPREAD_TIME = 3.5;
const POOL_SPREAD_FROM = 0.2;
/** Altura del decal (m) = DECAL_HEIGHT · (1 + edad): decal_blood.fs lee la edad de ahí. */
const DECAL_HEIGHT = 0.5;

const UP = vec3.fromValues(0, 1, 0);

export interface BloodHit {
  target: UnitComponent;
  /** Quién golpea (de él sale la dirección); null: una al azar. */
  source: UnitComponent | null;
  /** 0..1: cuánto daño respecto a su vida. */
  severity: number;
  crit: boolean;
  /** El golpe lo ha dejado fuera de combate: charco debajo. */
  kill: boolean;
}

interface Splat {
  entity: Entity | null;
  spawning: boolean;
  position: vec3;
  /** Giro sobre la vertical: su +X apunta hacia donde salió la sangre. */
  yaw: number;
  size: number;
  delay: number;
  age: number;
  lifetime: number;
  spreadFrom: number;
  spreadTime: number;
}

/**
 * BloodFX — la sangre de los golpes, en capas como en los juegos de acción:
 *  - chorro de gotas en la dirección del golpe (estiradas por su velocidad, iluminadas y con
 *    brillo húmedo; mueren al tocar el suelo) y un chorro corto hacia arriba;
 *  - neblina que se abre y se deshace;
 *  - manchas en el suelo donde caen las gotas (decal procedural, cada una distinta, alargadas
 *    hacia donde iban), que llegan extendiéndose y se secan con el tiempo;
 *  - si el golpe lo tumba, un charco que crece debajo.
 * Más sangre cuanto más daño, en los críticos y al matar. Los emisores son dos, compartidos.
 */
export class BloodFX {
  private spray: ParticleSystemComponent | null = null;
  private mist: ParticleSystemComponent | null = null;
  private loading = false;
  private splats: Splat[] = [];

  private readonly tmpPos = vec3.create();
  private readonly tmpDir = vec3.create();
  private readonly tmpVel = vec3.create();
  private readonly tmpRot = quat.create();
  private readonly tmpScale = vec3.create();

  /** Crea los emisores (una vez). */
  public init(): void {
    if (this.loading) return;
    this.loading = true;
    void spawn(SPRAY_PREFAB).then((e) => (this.spray = particlesOf(e)));
    void spawn(MIST_PREFAB).then((e) => (this.mist = particlesOf(e)));
  }

  public hit(h: BloodHit): void {
    const chest = h.target.getPosition(this.tmpPos);
    const floorY =
      groundHeightAt(chest[0]!, chest[2]!, chest[1]!) ?? chest[1]! - h.target.getFeetOffset();
    chest[1] = chest[1]! + CHEST_HEIGHT;

    // Dirección del golpe (horizontal): de quien golpea hacia el objetivo.
    const dir = this.tmpDir;
    if (h.source && h.source !== h.target) {
      h.source.getPosition(dir);
      vec3.set(dir, chest[0]! - dir[0]!, 0, chest[2]! - dir[2]!);
    } else {
      const a = Math.random() * Math.PI * 2;
      vec3.set(dir, Math.cos(a), 0, Math.sin(a));
    }
    if (vec3.length(dir) < 1e-4) vec3.set(dir, 1, 0, 0);
    vec3.normalize(dir, dir);

    // Cuánta sangre: el daño manda; crítico y muerte, más.
    const amount = 0.6 + 0.8 * h.severity + (h.crit ? 0.5 : 0) + (h.kill ? 0.4 : 0);
    const options = (speed: number, lift: number, sizeScale: number) => ({
      velocity: vec3.set(this.tmpVel, dir[0]! * speed, lift, dir[2]! * speed),
      floorY: floorY + 0.02,
      sizeScale,
    });
    this.spray?.burst(Math.round(50 * amount), chest, options(SPRAY_SPEED, SPRAY_LIFT, 0.9 + 0.3 * amount));
    this.spray?.burst(Math.round(15 * amount), chest, options(1.4, 3.2, 0.8));
    this.mist?.burst(Math.round(8 + 6 * amount), chest, options(2.2, 0.5, 0.8 + 0.4 * amount));

    // Manchas donde caen las gotas, delante (en la dirección del golpe).
    const count = 1 + (h.crit || h.kill ? 1 : 0);
    const yaw = Math.atan2(-dir[2]!, dir[0]!);
    for (let i = 0; i < count; i++) {
      const along = 0.45 + 0.4 * i + Math.random() * 0.25;
      const side = (Math.random() - 0.5) * 0.4;
      this.addSplat({
        position: vec3.fromValues(
          chest[0]! + dir[0]! * along - dir[2]! * side,
          floorY,
          chest[2]! + dir[2]! * along + dir[0]! * side,
        ),
        yaw: yaw + (Math.random() - 0.5) * 0.5,
        size: (1 + 0.5 * amount) * (0.85 + Math.random() * 0.3),
        delay: SPLAT_DELAY + 0.08 * i,
        lifetime: SPLAT_LIFETIME,
        spreadFrom: SPREAD_FROM,
        spreadTime: SPREAD_TIME,
      });
    }
    if (h.kill) {
      this.addSplat({
        position: vec3.fromValues(chest[0]! + dir[0]! * 0.3, floorY, chest[2]! + dir[2]! * 0.3),
        yaw: Math.random() * Math.PI * 2,
        size: 1.5 + 0.5 * h.severity,
        delay: POOL_DELAY,
        lifetime: POOL_LIFETIME,
        spreadFrom: POOL_SPREAD_FROM,
        spreadTime: POOL_SPREAD_TIME,
      });
    }
  }

  public update(dt: number): void {
    for (const s of this.splats) {
      if (s.delay > 0) {
        s.delay -= dt;
        continue;
      }
      if (!s.entity) {
        if (!s.spawning) {
          s.spawning = true;
          void spawn(SPLAT_PREFAB).then((e) => {
            if (this.splats.includes(s)) s.entity = e;
            else Engine.getEntities().destroyEntity(e);
          });
        }
        continue;
      }
      s.age += dt;
      this.place(s);
    }
    const dead = this.splats.filter((s) => s.entity && s.age >= s.lifetime);
    for (const s of dead) this.remove(s);
  }

  /** Quita toda la sangre (reinicio del encuentro). */
  public reset(): void {
    for (const s of [...this.splats]) this.remove(s);
  }

  private addSplat(def: Omit<Splat, 'entity' | 'spawning' | 'age'>): void {
    this.splats.push({ ...def, entity: null, spawning: false, age: 0 });
    // Demasiadas: la más vieja que aún no se esté yendo se apaga ya.
    const living = this.splats.filter((s) => s.lifetime - s.age > RETIRE_TIME);
    if (living.length > MAX_SPLATS) {
      const oldest = living[0]!;
      oldest.age = Math.max(oldest.age, oldest.lifetime * 0.8);
      oldest.lifetime = Math.min(oldest.lifetime, oldest.age + RETIRE_TIME);
    }
  }

  private place(s: Splat): void {
    const t = (s.entity!.getComponent('transform') as TransformComponent | null)?.getTransform();
    if (!t) return;
    const k = Math.min(1, s.age / s.spreadTime);
    const spread = s.spreadFrom + (1 - s.spreadFrom) * (1 - (1 - k) ** 3); // sale rápido y frena
    const size = s.size * spread;
    const age01 = Math.min(1, s.age / s.lifetime);
    t.setLocalPosition(s.position);
    t.setLocalRotation(quat.setAxisAngle(this.tmpRot, UP, s.yaw));
    t.setLocalScale(vec3.set(this.tmpScale, size, DECAL_HEIGHT * (1 + age01), size));
  }

  private remove(s: Splat): void {
    if (s.entity) Engine.getEntities().destroyEntity(s.entity);
    this.splats = this.splats.filter((x) => x !== s);
  }
}

function spawn(prefab: string): Promise<Entity> {
  return Loader.spawnFromJSON({ prefab, components: {} } as unknown as EntityDataType);
}

function particlesOf(e: Entity): ParticleSystemComponent | null {
  return e.getComponent('particle_system') as ParticleSystemComponent | null;
}
