import { vec3 } from 'gl-matrix';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { UnitComponent } from './UnitComponent';
import type { SurfaceType } from './Surfaces';

/**
 * Habilidades: modelo de datos genérico (public/data/skills.json) y geometría de sus áreas.
 * Las reglas (quién puede lanzarlas, recursos, cooldowns, efectos) las aplica
 * EncounterComponent con planSkill / requestSkill, igual que ataques y movimiento.
 */

/**
 * unit:  una unidad (filtrada por `targets`).
 * point: un punto del suelo; con `radius` > 0, un área circular alrededor.
 * cone:  un cono desde el lanzador hacia el punto (`length`, `angle`).
 * self:  el propio lanzador (sin elegir objetivo).
 */
export type SkillTargeting = 'unit' | 'point' | 'cone' | 'self';

export type SkillEffect =
  | { type: 'damage'; amount: number }
  | { type: 'heal'; amount: number }
  /** Aleja a los afectados del lanzador (o del centro del área). */
  | { type: 'push'; distance: number }
  /** El lanzador va en línea recta, muy rápido, hasta el punto (no gasta movimiento). */
  | { type: 'teleport' }
  /** Deja una superficie en el punto (fuego…). */
  | { type: 'surface'; surface: SurfaceType; radius: number };

export interface SkillDef {
  id: string;
  name: string;
  cost: 'action' | 'bonusAction';
  /** Turnos del lanzador que hay que esperar para volver a usarla (0 = sin cooldown). */
  cooldown: number;
  target: SkillTargeting;
  /** unit / point: alcance (m). Unidad: de borde a borde; punto: desde el lanzador. */
  range: number;
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
  /** Animación del lanzador. */
  clip?: string;
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
  const area = s.target === 'self' || s.target === 'cone';
  return {
    id,
    name: s.name,
    cost: s.cost,
    cooldown: s.cooldown ?? 0,
    target: s.target,
    range: s.range ?? 0,
    radius: s.radius ?? 0,
    length: s.length ?? 0,
    angle: s.angle ?? 60,
    targets: s.targets ?? 'any',
    affects: s.affects ?? 'all',
    lineOfSight: s.lineOfSight ?? !area,
    effects: s.effects,
    ...(s.clip !== undefined && { clip: s.clip }),
  };
}

export const hasEffect = (skill: SkillDef, type: SkillEffect['type']): boolean =>
  skill.effects.some((e) => e.type === type);

/** ¿Es hostil? (daña o empuja: el cursor es de ataque y empieza combates). */
export const isHostile = (skill: SkillDef): boolean =>
  hasEffect(skill, 'damage') || hasEffect(skill, 'push');

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
