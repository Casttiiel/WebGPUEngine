import { vec3 } from 'gl-matrix';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { UnitComponent } from './UnitComponent';
import { EYE_HEIGHT } from './CombatRules';
import { hasLineOfSight } from './TacticalQueries';
import type { SurfaceType } from './Surfaces';
import type { UnitStatusId } from './UnitComponent';
import type { AttributeId } from './Stats';

/**
 * Habilidades: modelo de datos genérico (public/data/skills.json) y geometría de sus áreas.
 * Las reglas (quién puede lanzarlas, recursos, cooldowns, efectos) las aplica
 * EncounterComponent con planSkill / requestSkill, igual que ataques y movimiento.
 */

/**
 * unit:  una unidad (filtrada por `targets`).
 * point: un punto del suelo; con `radius` > 0, un área circular alrededor.
 * cone:  un cono desde el lanzador hacia el punto (`length`, `angle`).
 * line:  una línea recta desde el lanzador hacia el punto (`length`, `width`): atraviesa a
 *        todos los que pille hasta la primera pared.
 * self:  el propio lanzador (sin elegir objetivo).
 */
export type SkillTargeting = 'unit' | 'point' | 'cone' | 'line' | 'self';

export type SkillEffect =
  /**
   * Daño base; se le suma el atributo de escala de la habilidad (`scale`). La tirada dentro
   * del rango de la armadura es una por lanzamiento (la misma fracción para todos).
   */
  | { type: 'damage'; amount: number; penetration?: number }
  | { type: 'heal'; amount: number }
  /** Aleja a los afectados del lanzador (o del centro del área). */
  | { type: 'push'; distance: number }
  /** El lanzador va en línea recta, muy rápido, hasta el punto (no gasta movimiento). */
  | { type: 'teleport' }
  /** Deja una superficie en el punto (fuego…). */
  | { type: 'surface'; surface: SurfaceType; radius: number }
  /**
   * Aplica un estado durante `turns` turnos suyos (fijos: POT no los alarga, GDD §3), o hasta
   * que empiece su siguiente turno (`untilTurnStart`). `amount` + `amountPerPoint` por punto
   * del atributo de escala: la magnitud (Marcado: % de daño extra).
   */
  | {
      type: 'status';
      status: UnitStatusId;
      turns: number;
      amount?: number;
      amountPerPoint?: number;
      untilTurnStart?: boolean;
    }
  /**
   * Empuje de acero: el objetivo metálico sale en línea recta alejándose del lanzador,
   * `3 + POT/2` m (GDD §5). Lo que choca recibe un IMPACTO. Se puede apuntar dentro de un
   * ángulo pequeño (`aimAngle`, grados en total; default 40: ±20° de "alejarlo de ti").
   */
  | { type: 'steelPush'; aimAngle?: number }
  /**
   * Tirón de hierro: el objetivo metálico viene hacia el lanzador, `3 + POT/2` m. Una unidad
   * con metal portado llega Derribada; si solo lleva un arma de metal, se la quita (desarme).
   */
  | { type: 'ironPull' }
  /** Salto de acero: hasta el punto, `6 + POT` m, sin gastar movimiento. */
  | { type: 'leap' }
  /**
   * Lanzar (peltre): el objetivo (una unidad o un objeto Grande, pegado al lanzador) sale en
   * arco hasta `distance` m adonde se elija. IMPACTO al caer (10 + FUE); una unidad queda
   * Derribada.
   */
  | { type: 'hurl'; distance: number }
  /** Deslizar: si acaba a la espalda de un enemigo (a su lado), lo deja Marcado. */
  | { type: 'flank' }
  /**
   * Remate: gasta todo el Ritmo contra el objetivo en un golpe del arma × (1 + 0,5 por punto);
   * con el Ritmo al máximo, además lo deja Aturdido.
   */
  | { type: 'finisher' }
  /**
   * Burbuja de bendaleo centrada en el lanzador, `radius` + `radiusPerPoint`·POT m, durante
   * `rounds` rondas (Zones).
   */
  | { type: 'bubble'; rounds: number; radius: number; radiusPerPoint?: number }
  /**
   * Acciones de metal (GDD §2, §11), sobre uno mismo y al momento:
   *   duralumin: quema toda la Reserva; la siguiente, ×(1 + quemado / máximo) y sin coste.
   *   refill:    se declara Seco: el turno siguiente sin alomancia y, al acabarlo, Reserva llena.
   */
  | { type: 'duralumin' }
  | { type: 'refill' };

export interface SkillDef {
  id: string;
  name: string;
  /** Recurso del turno que gasta. 'free': ninguno (decantar una mente de metal). */
  cost: 'action' | 'bonusAction' | 'free';
  /** Turnos del lanzador que hay que esperar para volver a usarla (0 = sin cooldown). */
  cooldown: number;
  target: SkillTargeting;
  /** unit / point: alcance (m). Unidad: de borde a borde; punto: desde el lanzador. */
  range: number;
  /** unit: distancia mínima al objetivo, de borde a borde (m). Default 0. */
  minRange: number;
  /** point / self: radio del área (0 = solo el objetivo). */
  radius: number;
  /** cone: longitud (m) y apertura (grados). */
  length: number;
  angle: number;
  /** unit: a quién se puede elegir. */
  targets: 'enemy' | 'ally' | 'any';
  /** Áreas: a quién afecta (all incluye aliados y objetos: cuidado con el fuego amigo). */
  affects: 'all' | 'enemies' | 'allies';
  /** Requiere línea de visión al objetivo. Default true salvo self y cone. */
  lineOfSight: boolean;
  effects: SkillEffect[];
  /** Coste en metal (puntos de la Reserva). Default 0. */
  metal: number;
  /**
   * Alomancia: estando Seco no se puede usar, y el duraluminio la potencia.
   * Default: true si cuesta metal.
   */
  allomantic: boolean;
  /** Atributo del lanzador que se suma al daño (Escala: POT, FUE…). Sin él, daño fijo. */
  scale?: AttributeId;
  /** line: ancho de la línea (m). Default 0.6. */
  width: number;
  /** Mente de metal que gasta una carga (feruquimia innata, p.ej. 'iron'). */
  charge?: string;
  /** Animación del lanzador. */
  clip?: string;
  /** Texto para la ficha del personaje (sin él se resume a partir de los efectos). */
  description?: string;
}

type SkillJson = Partial<Omit<SkillDef, 'id' | 'effects'>> &
  Pick<SkillDef, 'name' | 'cost' | 'target' | 'effects'>;

/** Catálogo de habilidades (data/skills.json), cargado una vez al empezar la escena. */
export class SkillCatalog {
  private static skills = new Map<string, SkillDef>();
  private static loading: Promise<void> | null = null;

  public static load(path = 'data/skills.json'): Promise<void> {
    this.loading ??= ResourceManager.fetch(path)
      .then((r) => r.json() as Promise<Record<string, SkillJson>>)
      .then((json) => {
        for (const [id, s] of Object.entries(json)) this.skills.set(id, normalize(id, s));
      })
      .catch((e) => console.error(`[Skills] cannot load ${path}`, e));
    return this.loading;
  }

  public static get(id: string): SkillDef | null {
    return this.skills.get(id) ?? null;
  }

  public static getAll(): SkillDef[] {
    return [...this.skills.values()];
  }
}

function normalize(id: string, s: SkillJson): SkillDef {
  const area = s.target === 'self' || s.target === 'cone' || s.target === 'line';
  return {
    id,
    name: s.name,
    cost: s.cost,
    cooldown: s.cooldown ?? 0,
    target: s.target,
    range: s.range ?? 0,
    minRange: s.minRange ?? 0,
    radius: s.radius ?? 0,
    length: s.length ?? 0,
    angle: s.angle ?? 60,
    targets: s.targets ?? 'any',
    affects: s.affects ?? 'all',
    lineOfSight: s.lineOfSight ?? !area,
    width: s.width ?? 0.6,
    effects: s.effects,
    ...(s.charge !== undefined && { charge: s.charge }),
    metal: s.metal ?? 0,
    allomantic: s.allomantic ?? (s.metal ?? 0) > 0,
    ...(s.scale !== undefined && { scale: s.scale }),
    ...(s.clip !== undefined && { clip: s.clip }),
    ...(s.description !== undefined && { description: s.description }),
  };
}

export const hasEffect = (skill: SkillDef, type: SkillEffect['type']): boolean =>
  skill.effects.some((e) => e.type === type);

/** ¿Es una acción de metal (duraluminio, recargar)? */
export const isMetalAction = (skill: SkillDef): boolean =>
  skill.effects.some((e) => e.type === 'duralumin' || e.type === 'refill');

/** ¿Es hostil? (daña, empuja o atrae: el cursor es de ataque y empieza combates). */
export const isHostile = (skill: SkillDef): boolean =>
  skill.target !== 'self' &&
  (hasEffect(skill, 'damage') ||
    hasEffect(skill, 'push') ||
    hasEffect(skill, 'status') ||
    hasEffect(skill, 'steelPush') ||
    hasEffect(skill, 'ironPull') ||
    hasEffect(skill, 'hurl') ||
    hasEffect(skill, 'finisher'));

/** ¿`unit` cuenta para el filtro del área (relativo al bando del lanzador)? */
function passesAffects(skill: SkillDef, caster: UnitComponent, unit: UnitComponent): boolean {
  if (skill.affects === 'all') return true;
  const ally = unit.getFaction() === caster.getFaction();
  return skill.affects === 'allies' ? ally : !ally;
}

const tmp = vec3.create();

/** Unidades vivas dentro de un círculo (hasta su borde) centrado en `center`. */
export function unitsInCircle(
  skill: SkillDef,
  caster: UnitComponent,
  center: vec3,
  radius: number,
): UnitComponent[] {
  return UnitComponent.getAll().filter((u) => {
    if (!u.isAlive() || !passesAffects(skill, caster, u)) return false;
    const p = u.getFeetPosition(tmp);
    const d = Math.hypot(p[0]! - center[0]!, p[2]! - center[2]!) - u.getCapsuleRadius();
    return d <= radius && Math.abs(p[1]! - center[1]!) < 2;
  });
}

/** Unidades vivas dentro del cono del lanzador hacia `toward` (sin el lanzador). */
export function unitsInCone(skill: SkillDef, caster: UnitComponent, toward: vec3): UnitComponent[] {
  const origin = caster.getFeetPosition(vec3.create());
  const dir = coneDirection(origin, toward);
  const halfAngle = (skill.angle * Math.PI) / 360;
  return UnitComponent.getAll().filter((u) => {
    if (u === caster || !u.isAlive() || !passesAffects(skill, caster, u)) return false;
    const p = u.getFeetPosition(tmp);
    const dx = p[0]! - origin[0]!;
    const dz = p[2]! - origin[2]!;
    const dist = Math.hypot(dx, dz);
    if (dist - u.getCapsuleRadius() > skill.length || Math.abs(p[1]! - origin[1]!) > 2)
      return false;
    if (dist < 1e-3) return true;
    const cos = (dx * dir[0]! + dz * dir[2]!) / dist;
    // Se cuenta el borde de la unidad: un poco de margen angular según su tamaño.
    const margin = Math.atan2(u.getCapsuleRadius(), dist);
    return Math.acos(Math.min(1, Math.max(-1, cos))) <= halfAngle + margin;
  });
}

/**
 * Hasta dónde llega una línea desde el lanzador en `dir` (como mucho `length`): se corta en la
 * primera pared (a la altura del pecho). Búsqueda binaria con rayos de línea de visión.
 */
export function lineReach(caster: UnitComponent, dir: vec3, length: number): number {
  const eye = caster.getPosition(vec3.create());
  eye[1] = eye[1]! + EYE_HEIGHT * 0.5;
  const at = (d: number) => vec3.scaleAndAdd(vec3.create(), eye, dir, d);
  if (hasLineOfSight(eye, at(length))) return length;
  let lo = 0;
  let hi = length;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (hasLineOfSight(eye, at(mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Unidades vivas dentro de la línea del lanzador hacia `toward` (sin el lanzador), hasta
 * `reach` m (el borde de cada una cuenta), ordenadas de la más cercana a la más lejana.
 */
export function unitsInLine(
  skill: SkillDef,
  caster: UnitComponent,
  toward: vec3,
  reach: number,
): UnitComponent[] {
  const origin = caster.getFeetPosition(vec3.create());
  const dir = coneDirection(origin, toward);
  const out: { u: UnitComponent; along: number }[] = [];
  for (const u of UnitComponent.getAll()) {
    if (u === caster || !u.isAlive() || !passesAffects(skill, caster, u)) continue;
    const p = u.getFeetPosition(tmp);
    const dx = p[0]! - origin[0]!;
    const dz = p[2]! - origin[2]!;
    const along = dx * dir[0]! + dz * dir[2]!;
    const side = Math.abs(dx * dir[2]! - dz * dir[0]!);
    if (along < 0 || along - u.getCapsuleRadius() > reach || Math.abs(p[1]! - origin[1]!) > 2) {
      continue;
    }
    if (side <= skill.width / 2 + u.getCapsuleRadius()) out.push({ u, along });
  }
  return out.sort((a, b) => a.along - b.along).map((o) => o.u);
}

/** Contorno de una línea: rectángulo de `width` desde `origin` en `dir`, `length` m. */
export function lineOutline(origin: vec3, dir: vec3, length: number, width: number): vec3[] {
  const half = width / 2;
  const side = vec3.fromValues(-dir[2]!, 0, dir[0]!);
  const at = (d: number, s: number) =>
    vec3.fromValues(
      origin[0]! + dir[0]! * d + side[0]! * s,
      origin[1]!,
      origin[2]! + dir[2]! * d + side[2]! * s,
    );
  return [at(0, -half), at(length, -half), at(length, half), at(0, half), at(0, -half)];
}

/** Dirección horizontal normalizada de `from` hacia `to` (+Z si coinciden). */
export function coneDirection(from: vec3, to: vec3): vec3 {
  const dir = vec3.fromValues(to[0]! - from[0]!, 0, to[2]! - from[2]!);
  if (vec3.length(dir) < 1e-4) return vec3.fromValues(0, 0, 1);
  return vec3.normalize(dir, dir);
}

/** Contorno de un círculo en el suelo (para la vista previa con puntos). */
export function circleOutline(center: vec3, radius: number, segments = 32): vec3[] {
  const out: vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(
      vec3.fromValues(
        center[0]! + Math.cos(a) * radius,
        center[1]!,
        center[2]! + Math.sin(a) * radius,
      ),
    );
  }
  return out;
}

/** Contorno de un cono: lanzador → borde → arco → borde → lanzador. */
export function coneOutline(origin: vec3, dir: vec3, length: number, angleDeg: number): vec3[] {
  const half = (angleDeg * Math.PI) / 360;
  const base = Math.atan2(dir[2]!, dir[0]!);
  const at = (a: number, r: number) =>
    vec3.fromValues(origin[0]! + Math.cos(a) * r, origin[1]!, origin[2]! + Math.sin(a) * r);
  const out = [vec3.clone(origin)];
  const steps = 10;
  for (let i = 0; i <= steps; i++) out.push(at(base - half + (2 * half * i) / steps, length));
  out.push(vec3.clone(origin));
  return out;
}
