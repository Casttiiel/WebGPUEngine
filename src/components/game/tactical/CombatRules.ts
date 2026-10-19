import { vec3 } from 'gl-matrix';
import { UnitComponent, type UnitAttack } from './UnitComponent';
import { hasLineOfSight } from './TacticalQueries';
import type { SkillDef } from './Skills';
import { PropComponent } from './PropComponent';
import { averageOf, critDamageFor, mitigatedRange, rollRange, type DamageRange } from './Stats';

/**
 * Reglas del combate que no dependen del turno: distancias, línea de visión y resolución
 * de ataques (daño fijo + armadura → rango, GDD §4; fórmulas en Stats.ts). Las usan EncounterComponent (jugador, MCP e IA) y la UI (tooltips).
 */

/** Altura de los ojos sobre el centro de la cápsula. */
export const EYE_HEIGHT = 0.7;

const tmpA = vec3.create();
const tmpB = vec3.create();

/** Distancia horizontal entre dos unidades, de borde a borde de sus cápsulas. */
export function unitDistance(a: UnitComponent, b: UnitComponent): number {
  const pa = a.getPosition(tmpA);
  const pb = b.getPosition(tmpB);
  const center = Math.hypot(pb[0]! - pa[0]!, pb[2]! - pa[2]!);
  return Math.max(0, center - a.getCapsuleRadius() - b.getCapsuleRadius());
}

/**
 * ¿Ve `from` a `to`? Rayo desde sus ojos a los ojos o al pecho del objetivo; solo bloquea
 * la geometría estática. Un muro bajo no tapa (se ve la cabeza); una columna sí.
 */
export function unitLineOfSight(from: UnitComponent, to: UnitComponent): boolean {
  const eye = from.getPosition(tmpA);
  eye[1] = eye[1]! + EYE_HEIGHT;
  const target = to.getPosition(tmpB);
  target[1] = target[1]! + EYE_HEIGHT;
  if (hasLineOfSight(eye, target)) return true;
  target[1] = target[1]! - EYE_HEIGHT;
  return hasLineOfSight(eye, target);
}

/**
 * Como unitDistance, pero con `unit` colocada con los pies en `feet` (posición hipotética:
 * la IA evalúa sitios a los que moverse).
 */
export function unitDistanceFrom(unit: UnitComponent, feet: vec3, target: UnitComponent): number {
  const pb = target.getPosition(tmpB);
  const center = Math.hypot(pb[0]! - feet[0]!, pb[2]! - feet[2]!);
  return Math.max(0, center - unit.getCapsuleRadius() - target.getCapsuleRadius());
}

/** Como unitLineOfSight, pero con `unit` colocada con los pies en `feet`. */
export function unitLineOfSightFrom(
  unit: UnitComponent,
  feet: vec3,
  target: UnitComponent,
): boolean {
  const eye = vec3.copy(tmpA, feet);
  eye[1] = eye[1]! + unit.getFeetOffset() + EYE_HEIGHT;
  const aim = target.getPosition(tmpB);
  aim[1] = aim[1]! + EYE_HEIGHT;
  if (hasLineOfSight(eye, aim)) return true;
  aim[1] = aim[1]! - EYE_HEIGHT;
  return hasLineOfSight(eye, aim);
}

export interface AttackRoll {
  /** Probabilidad de impacto (0-1). Siempre 1: se acierta siempre (GDD §4). */
  hitChance: number;
  /** Daño medio si impacta (sin crítico): para comparar opciones. */
  damage: number;
  /** Rango si impacta (sin crítico): D con la armadura del objetivo. La vista previa. */
  minDamage: number;
  maxDamage: number;
  /** Daño del crítico: máx × 1,5, ignora la armadura. */
  critDamage: number;
  /** Probabilidad (0-1) de que sea crítico si impacta: sale de su bolsa de canicas. */
  critChance: number;
}

/** Probabilidad de que un proyectil falle contra la Burbuja de acero (GDD §10.1). */
export const STEEL_BUBBLE_MISS = 0.5;

/**
 * Multiplicador del daño que recibe `target` en el próximo golpe: Marcado, +`amount` % (se
 * consume al recibirlo, EncounterComponent.applyHit).
 */
export function damageTakenMultiplier(target: UnitComponent): number {
  const mark = target.getStatus('marked');
  return mark ? 1 + (mark.amount ?? 50) / 100 : 1;
}

/**
 * Lo que hace un golpe de `damage` (D) de `attacker` a `target`: el rango con la armadura
 * del objetivo menos la penetración del atacante (sin atacante, p.ej. un objeto: sin
 * penetración) y la `extraPenetration` del golpe (Bala empujada). Marcado: D × (1 + %).
 */
export function hitRange(
  attacker: UnitComponent | null,
  target: UnitComponent,
  damage: number,
  extraPenetration = 0,
): DamageRange {
  const penetration = (attacker?.getPenetration() ?? 0) + extraPenetration;
  const marked = Math.round(damage * damageTakenMultiplier(target));
  return mitigatedRange(marked, target.getArmor(), penetration);
}

/** ¿Es de metal? (metal portado, o un objeto metálico): el acero y el hierro le afectan. */
export function isMetallic(unit: UnitComponent): boolean {
  return unit.isMetallic() || PropComponent.of(unit.getOwner())?.isMetallic() === true;
}

/**
 * Ataque con un arma: D = arma + FUE; rango por la armadura; crítico = máx × 1,5 (con el
 * Marcado también). Se acierta siempre salvo un proyectil contra la Burbuja de acero (50 %).
 * El melee contra un Derribado es crítico seguro.
 */
export function previewAttack(
  attacker: UnitComponent,
  target: UnitComponent,
  attack: UnitAttack,
): AttackRoll {
  const damage = attacker.getAttackDamage(attack);
  const range = hitRange(attacker, target, damage);
  const bubble = attack.kind === 'ranged' && target.hasStatus('steel_bubble');
  return {
    hitChance: bubble ? 1 - STEEL_BUBBLE_MISS : 1,
    damage: averageOf(range),
    minDamage: range.min,
    maxDamage: range.max,
    critDamage: critDamageFor(damage * damageTakenMultiplier(target)),
    critChance: guaranteedCrit(target, attack) ? 1 : attacker.getNextCritChance(),
  };
}

/** El melee contra un Derribado es crítico seguro (GDD §6). */
function guaranteedCrit(target: UnitComponent, attack: UnitAttack): boolean {
  return attack.kind === 'melee' && target.hasStatus('prone');
}

/**
 * Tira el ataque. Con 100 % de impacto no consume números del RNG para el impacto; si impacta
 * saca el crítico de la bolsa del atacante (UnitComponent.rollCrit): un crítico hace
 * máx × 1,5 sin mirar la armadura; si no, un entero uniforme en el rango.
 */
export function rollAttack(
  attacker: UnitComponent,
  target: UnitComponent,
  attack: UnitAttack,
): { hit: boolean; crit: boolean; damage: number } {
  const roll = previewAttack(attacker, target, attack);
  const hit = roll.hitChance >= 1 || Math.random() < roll.hitChance;
  if (!hit) return { hit, crit: false, damage: 0 };
  const crit = guaranteedCrit(target, attack) || attacker.rollCrit();
  const damage = crit ? roll.critDamage : rollRange({ min: roll.minDamage, max: roll.maxDamage });
  return { hit, crit, damage };
}

/**
 * D de una habilidad: la suma de sus efectos de daño + el atributo de escala (una vez), por
 * `power` (duraluminio: ×(1 + quemado / máximo)), redondeado.
 */
export function skillDamage(caster: UnitComponent, skill: SkillDef, power = 1): number {
  let base = 0;
  let any = false;
  for (const effect of skill.effects) {
    if (effect.type !== 'damage') continue;
    base += effect.amount;
    any = true;
  }
  if (!any) return 0;
  return Math.round((base + (skill.scale ? caster.getAttribute(skill.scale) : 0)) * power);
}

/**
 * Lo que costaría ahora la habilidad de la Reserva de `caster` y cuánto la potencia: con
 * duraluminio, gratis (ya está quemado) y ×(1 + quemado / máximo). Lo que no es alomántico ni
 * cuesta ni se potencia.
 */
export function metalCost(
  caster: UnitComponent,
  skill: SkillDef,
): { metal: number; power: number } {
  if (!skill.allomantic) return { metal: 0, power: 1 };
  const boost = caster.getMetalBoost();
  if (boost) return { metal: 0, power: boost.power };
  return { metal: skill.metal, power: 1 };
}
