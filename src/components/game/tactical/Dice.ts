/**
 * Daño con dados, como en D&D 5e / Baldur's Gate 3: "1d8+3" = un dado de 8 caras más 3
 * (de 4 a 11). Cada ataque tira los dados; en un crítico se tiran el doble de dados (el
 * modificador no se duplica). Un número es un daño fijo.
 */
export type DamageValue = number | string;

export interface Dice {
  count: number;
  sides: number;
  bonus: number;
}

const DICE = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** "2d6+3" → { count: 2, sides: 6, bonus: 3 }; un número → sin dados. */
export function parseDice(value: DamageValue): Dice {
  if (typeof value === 'number') return { count: 0, sides: 0, bonus: value };
  const m = DICE.exec(value);
  if (!m) {
    const fixed = Number(value);
    if (Number.isFinite(fixed)) return { count: 0, sides: 0, bonus: fixed };
    throw new Error(`Daño no válido: "${value}" (se espera p.ej. "1d8+3" o un número)`);
  }
  const bonus = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
  return { count: Number(m[1]), sides: Number(m[2]), bonus };
}

/** Daño mínimo y máximo (sin crítico). */
export function damageRange(value: DamageValue): { min: number; max: number } {
  const d = parseDice(value);
  return {
    min: Math.max(0, d.count + d.bonus),
    max: Math.max(0, d.count * d.sides + d.bonus),
  };
}

/** Daño medio (sin crítico): para la IA y para comparar opciones. */
export function averageDamage(value: DamageValue): number {
  const d = parseDice(value);
  return Math.max(0, (d.count * (d.sides + 1)) / 2 + d.bonus);
}

/** Tira el daño (RNG del juego). `crit`: el doble de dados. */
export function rollDamage(value: DamageValue, crit = false): number {
  const d = parseDice(value);
  const dice = crit ? d.count * 2 : d.count;
  let total = d.bonus;
  for (let i = 0; i < dice; i++) total += 1 + Math.floor(Math.random() * d.sides);
  return Math.max(0, total);
}

/** "1d8+3" → "1d8+3 (4~11)" (la fuente de la UI no tiene "–"); un número → "10". */
export function damageText(value: DamageValue): string {
  if (typeof value === 'number' || parseDice(value).count === 0) {
    return String(parseDice(value).bonus);
  }
  const { min, max } = damageRange(value);
  return `${value.replace(/\s+/g, '')} (${min}~${max})`;
}
