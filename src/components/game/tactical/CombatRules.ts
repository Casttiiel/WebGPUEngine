import { vec3 } from 'gl-matrix';
import { UnitComponent, type UnitAttack } from './UnitComponent';
import { hasLineOfSight } from './TacticalQueries';
import { averageDamage, damageRange, rollDamage } from './Dice';

/**
 * Reglas del combate que no dependen del turno: distancias, línea de visión y resolución
 * de ataques. Las usan EncounterComponent (jugador, MCP e IA) y la UI (tooltips).
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
  /** Probabilidad de impacto (0-1). */
  hitChance: number;
  /** Daño medio si impacta (sin crítico): para comparar opciones. */
  damage: number;
  /** Daño mínimo y máximo si impacta (sin crítico): la vista previa en la barra de vida. */
  minDamage: number;
  maxDamage: number;
  /** Probabilidad (0-1) de que sea crítico si impacta: sale de su bolsa de canicas. */
  critChance: number;
}

/**
 * Probabilidad de impacto, daño y crítico de un ataque. Hoy: 100 % y daño fijo del arma.
 * Punto de enganche para stats (atributos, armadura, ventaja por altura, cobertura…).
 */
export function previewAttack(
  attacker: UnitComponent,
  _target: UnitComponent,
  attack: UnitAttack,
): AttackRoll {
  const { min, max } = damageRange(attack.damage);
  return {
    hitChance: 1,
    damage: averageDamage(attack.damage),
    minDamage: min,
    maxDamage: max,
    critChance: attacker.getNextCritChance(),
  };
}

/**
 * Tira el ataque. Con 100 % de impacto no consume números del RNG para el impacto; si impacta
 * saca el crítico de la bolsa del atacante (UnitComponent.rollCrit).
 */
export function rollAttack(
  attacker: UnitComponent,
  target: UnitComponent,
  attack: UnitAttack,
): { hit: boolean; crit: boolean; damage: number } {
  const roll = previewAttack(attacker, target, attack);
  const hit = roll.hitChance >= 1 || Math.random() < roll.hitChance;
  if (!hit) return { hit, crit: false, damage: 0 };
  // Se tiran los dados; el crítico tira el doble de dados (el modificador no se duplica).
  const crit = attacker.rollCrit();
  return { hit, crit, damage: rollDamage(attack.damage, crit) };
}
