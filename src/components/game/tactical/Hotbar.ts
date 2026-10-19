import type { UnitAttack, UnitComponent } from './UnitComponent';
import { SkillCatalog, type SkillDef } from './Skills';
import { COST_NAME, attackSummary, fmt, skillMechanics, turns } from './ActionText';
import { MAX_JUMP, THROW_RANGE } from './EnvironmentRules';

export type HotbarKind = 'melee' | 'ranged' | 'jump' | 'push' | 'throw' | 'skill';
export type HotbarCost = 'action' | 'bonusAction' | 'movement';

/** Una entrada de la hotbar: un ataque, una acción de entorno o una habilidad. */
export interface HotbarEntry {
  /** Id que se arma en el puntero: el del ataque, 'jump', 'push', 'throw' o el de la habilidad. */
  id: string;
  name: string;
  kind: HotbarKind;
  cost: HotbarCost;
  attack: UnitAttack | null;
  skill: SkillDef | null;
}

export type AbilityId = 'jump' | 'push' | 'throw';

const ABILITIES: Record<AbilityId, Omit<HotbarEntry, 'attack' | 'skill'>> = {
  jump: { id: 'jump', name: 'Saltar', kind: 'jump', cost: 'movement' },
  push: { id: 'push', name: 'Empujar', kind: 'push', cost: 'bonusAction' },
  throw: { id: 'throw', name: 'Lanzar', kind: 'throw', cost: 'action' },
};

/** Ataques de la unidad (en su orden), sus acciones de entorno y sus habilidades. */
export function hotbarEntries(unit: UnitComponent): HotbarEntry[] {
  const skills = unit
    .getSkillIds()
    .map((id) => SkillCatalog.get(id))
    .filter((s): s is SkillDef => s !== null);
  return [
    ...unit.getAttacks().map(
      (a): HotbarEntry => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        cost: a.cost ?? 'action',
        attack: a,
        skill: null,
      }),
    ),
    ...unit
      .getAbilities()
      .map((ability): HotbarEntry => ({ ...ABILITIES[ability], attack: null, skill: null })),
    ...skills.map(
      (s): HotbarEntry => ({
        id: s.id,
        name: s.name,
        kind: 'skill',
        cost: s.cost,
        attack: null,
        skill: s,
      }),
    ),
  ];
}

export function isAbilityId(id: string | null): id is AbilityId {
  return id === 'jump' || id === 'push' || id === 'throw';
}

/** La habilidad con ese id, si `unit` la tiene. */
export function unitSkill(
  unit: UnitComponent | null | undefined,
  id: string | null,
): SkillDef | null {
  if (!unit || !id || !unit.hasSkill(id)) return null;
  return SkillCatalog.get(id);
}

/** Por qué no se puede pagar una habilidad con la Reserva (EncounterComponent.metalBlocker). */
export const METAL_BLOCKER_TEXT: Record<string, string> = {
  drained: 'Seco: sin alomancia este turno',
  'not enough metal': 'No llega el metal de la Reserva',
  'no metal': 'La Reserva está vacía',
  'reserve full': 'La Reserva está llena',
  'already boosted': 'Ya hay una habilidad potenciada',
  'already drained': 'Ya te has declarado Seco',
  'only in combat': 'Solo en combate',
};

/** Una línea del tooltip: datos (gris), descripción (gris claro) o por qué no se puede (rojo). */
export interface TooltipLine {
  text: string;
  style: 'info' | 'description' | 'warning';
}

/**
 * Tooltip de un hueco de la hotbar: el nombre y las líneas (coste, recarga, qué hace, la
 * descripción y lo que falta si no se puede usar). Los mismos textos que la ficha del
 * personaje (ActionText). `cooldown`: turnos que le quedan a una habilidad. `unit`: quién
 * la usa (los números salen de sus atributos).
 */
export function hotbarTooltip(
  entry: HotbarEntry,
  enabled: boolean,
  cooldown = 0,
  unit?: UnitComponent,
  blocker: string | null = null,
): { title: string; lines: TooltipLine[] } {
  const lines: TooltipLine[] = [];
  const info = (text: string) => lines.push({ text, style: 'info' });
  if (entry.attack) {
    info(attackSummary(entry.attack, unit));
    if (entry.kind === 'ranged') info('Necesita línea de visión.');
  } else if (entry.skill) {
    const s = entry.skill;
    const recharge = s.cooldown > 0 ? ` · recarga ${turns(s.cooldown)}` : '';
    const metal = s.metal > 0 ? ` · ${s.metal} de metal` : '';
    info(`${COST_NAME[s.cost]}${metal}${recharge}${s.allomantic ? ' · alomancia' : ''}`);
    info(skillMechanics(s, unit));
    if (s.description) lines.push({ text: s.description, style: 'description' });
  } else if (entry.kind === 'jump') {
    info(`Movimiento · hasta ${fmt(MAX_JUMP)} m, gasta los metros saltados`);
    lines.push({ text: 'Por encima de cajas y muros bajos.', style: 'description' });
  } else if (entry.kind === 'push') {
    info(`${COST_NAME.bonusAction} · elige un objeto y hacia dónde: sale en línea recta`);
    info('Daño de impacto a quien pille (el objeto también lo recibe)');
    lines.push({ text: 'Desliza una caja o un barril.', style: 'description' });
  } else {
    info(`${COST_NAME.action} · elige un objeto y dónde lanzarlo (hasta ${fmt(THROW_RANGE)} m)`);
    info('Vuela en arco; daño de impacto a quien golpee y al objeto al caer');
    lines.push({ text: 'Un barril lanzado explota al caer.', style: 'description' });
  }
  if (cooldown > 0) {
    lines.push({ text: `Disponible en ${turns(cooldown)}`, style: 'warning' });
  } else if (blocker) {
    lines.push({ text: METAL_BLOCKER_TEXT[blocker] ?? blocker, style: 'warning' });
  } else if (!enabled) {
    lines.push({ text: `Sin ${COST_NAME[entry.cost]!.toLowerCase()}`, style: 'warning' });
  }
  return { title: entry.name, lines };
}
