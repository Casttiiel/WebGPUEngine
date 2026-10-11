import { vec3 } from 'gl-matrix';
import { UnitComponent, type UnitAttack } from './UnitComponent';
import { hasLineOfSight } from './TacticalQueries';

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

export interface AttackRoll {
  /** Probabilidad de impacto (0-1). */
  hitChance: number;
  /** Daño si impacta. */
  damage: number;
}

/**
 * Probabilidad de impacto y daño de un ataque. Hoy: 100 % y daño fijo del arma.
 * Punto de enganche para stats (atributos, armadura, ventaja por altura, cobertura…).
 */
export function previewAttack(
  _attacker: UnitComponent,
  _target: UnitComponent,
  attack: UnitAttack,
): AttackRoll {
  return { hitChance: 1, damage: attack.damage };
}

/** Tira el ataque. Con 100 % de impacto no consume números del RNG. */
export function rollAttack(
  attacker: UnitComponent,
  target: UnitComponent,
  attack: UnitAttack,
): { hit: boolean; damage: number } {
  const roll = previewAttack(attacker, target, attack);
  const hit = roll.hitChance >= 1 || Math.random() < roll.hitChance;
  return { hit, damage: hit ? roll.damage : 0 };
}
