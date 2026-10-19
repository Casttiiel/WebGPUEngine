/**
 * Atributos y estadísticas derivadas (GDD §3) y daño con armadura (GDD §4).
 *
 * Seis atributos en tres pares (intensidad / aguante): Fuerza y Resistencia, Potencia y
 * Temple, Reflejos y Agudeza. Cada uno hace una sola cosa; las fórmulas están aquí para
 * afinarlas jugando sin buscarlas por el código.
 *
 * El daño no lleva dados: un ataque hace `arma + FUE` y una habilidad `base + atributo de
 * escala`. La armadura no quita daño seguro, quita certeza: el máximo es siempre D y el
 * mínimo baja con la armadura (hiperbólica, K = 12). El crítico ignora la armadura y hace
 * `máx × 1,5`. Los dados solo quedan en la iniciativa (1d4).
 */

export const ATTRIBUTES = ['FUE', 'RES', 'POT', 'TEM', 'REF', 'AGU'] as const;
export type AttributeId = (typeof ATTRIBUTES)[number];
export type Attributes = Record<AttributeId, number>;

export const ATTRIBUTE_NAME: Record<AttributeId, string> = {
  FUE: 'Fuerza',
  RES: 'Resistencia',
  POT: 'Potencia',
  TEM: 'Temple',
  REF: 'Reflejos',
  AGU: 'Agudeza',
};

/** Constante de la armadura: con A_ef = K se mitiga la mitad del mínimo. */
export const ARMOR_K = 12;
/** Multiplicador del crítico sobre el daño máximo. */
export const CRIT_MULTIPLIER = 1.5;

/** Atributos de una unidad: los que no se dan valen 0. */
export function makeAttributes(data: Partial<Record<AttributeId, number>> = {}): Attributes {
  const out = {} as Attributes;
  for (const id of ATTRIBUTES) out[id] = data[id] ?? 0;
  return out;
}

// ── Derivadas ──────────────────────────────────────────────────────────────

/** Vida = 25 + 6·RES + 5·(nivel − 1). */
export const maxHpFor = (a: Attributes, level = 1): number => 25 + 6 * a.RES + 5 * (level - 1);

/** Movimiento (m por turno) = 6 + REF/2. */
export const movementFor = (a: Attributes): number => 6 + a.REF / 2;

/** % de crítico = 5 % · (1 + ⌊AGU/2⌋): siempre múltiplo de 5 %. */
export const critChanceFor = (a: Attributes): number => 5 * (1 + Math.floor(a.AGU / 2));

/** Reserva de metal máxima = 6 + TEM (GDD §2). */
export const maxMetalFor = (a: Attributes): number => 6 + a.TEM;

/** Penetración de armadura = ⌊AGU/2⌋. */
export const penetrationFor = (a: Attributes): number => Math.floor(a.AGU / 2);

/** Parte fija de la iniciativa (2·REF); se le suma 1d4 al empezar el combate. */
export const initiativeBaseFor = (a: Attributes): number => 2 * a.REF;

/** Iniciativa = 2·REF + 1d4. */
export function rollInitiative(a: Attributes): number {
  return initiativeBaseFor(a) + rollDie(4);
}

/** Distancia de empuje y tirón de acero y hierro (m) = 3 + POT/2. */
export const steelDistanceFor = (a: Attributes): number => 3 + a.POT / 2;

/** Distancia del salto de acero (m) = 6 + POT. */
export const steelJumpFor = (a: Attributes): number => 6 + a.POT;

/** Un dado de `sides` caras (RNG del juego). */
export function rollDie(sides: number): number {
  return 1 + Math.floor(Math.random() * sides);
}

// ── Daño y armadura ────────────────────────────────────────────────────────

export interface DamageRange {
  min: number;
  max: number;
}

/**
 * Rango de daño de un golpe de `damage` (D) contra `armor` con `penetration`:
 *   A_ef = max(0, A − pen) · mitig = A_ef / (A_ef + K) · mín = round(D·(1 − mitig)) · máx = D.
 */
export function mitigatedRange(damage: number, armor = 0, penetration = 0): DamageRange {
  const max = Math.max(0, Math.round(damage));
  const effective = Math.max(0, armor - penetration);
  const mitigation = effective / (effective + ARMOR_K);
  return { min: Math.round(max * (1 - mitigation)), max };
}

/** Daño de un crítico: ignora la armadura y hace máx × 1,5. */
export const critDamageFor = (damage: number): number =>
  Math.round(Math.max(0, damage) * CRIT_MULTIPLIER);

/** Daño medio de un rango (uniforme). */
export const averageOf = (range: DamageRange): number => (range.min + range.max) / 2;

/**
 * Entero uniforme en [mín, máx]. `u` (0-1) es la tirada: una habilidad tira una vez y la
 * aplica a todos los afectados, cada uno con su armadura.
 */
export function rollRange(range: DamageRange, u = Math.random()): number {
  const span = range.max - range.min + 1;
  return range.min + Math.min(span - 1, Math.floor(u * span));
}

/** "7~10", o "10" si no hay rango (la fuente de la UI no tiene "–"). */
export function rangeText(range: DamageRange): string {
  return range.min === range.max ? `${range.max}` : `${range.min}~${range.max}`;
}
