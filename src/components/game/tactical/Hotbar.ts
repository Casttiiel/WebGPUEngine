import type { UnitAttack, UnitComponent } from './UnitComponent';
import { SkillCatalog, type SkillDef } from './Skills';

export type HotbarKind = 'melee' | 'ranged' | 'jump' | 'push' | 'skill';
export type HotbarCost = 'action' | 'bonusAction' | 'movement';

/** Una entrada de la hotbar: un ataque, una acción de entorno o una habilidad. */
export interface HotbarEntry {
  /** Id que se arma en el puntero: el del ataque, 'jump', 'push' o el de la habilidad. */
  id: string;
  name: string;
  kind: HotbarKind;
  cost: HotbarCost;
  attack: UnitAttack | null;
  skill: SkillDef | null;
}

const ABILITIES: Record<'jump' | 'push', Omit<HotbarEntry, 'attack' | 'skill'>> = {
  jump: { id: 'jump', name: 'Saltar', kind: 'jump', cost: 'movement' },
  push: { id: 'push', name: 'Empujar', kind: 'push', cost: 'bonusAction' },
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

export function isAbilityId(id: string | null): id is 'jump' | 'push' {
  return id === 'jump' || id === 'push';
}

/** La habilidad con ese id, si `unit` la tiene. */
export function unitSkill(
  unit: UnitComponent | null | undefined,
  id: string | null,
): SkillDef | null {
  if (!unit || !id || !unit.hasSkill(id)) return null;
  return SkillCatalog.get(id);
}

const COST_TEXT: Record<HotbarCost, string> = {
  action: 'Acción',
  bonusAction: 'Acción adicional',
  movement: 'Movimiento',
};

/** Texto de los efectos de una habilidad: "10 daño en 2.5 m, fuego". */
function skillEffects(skill: SkillDef): string {
  const parts = skill.effects.map((e) => {
    switch (e.type) {
      case 'damage':
        return `${e.amount} daño`;
      case 'heal':
        return `cura ${e.amount}`;
      case 'push':
        return `empuja ${e.distance} m`;
      case 'teleport':
        return 'se lanza en línea recta';
      case 'surface':
        return e.surface === 'fire' ? 'deja fuego' : 'deja aceite';
    }
  });
  const area =
    skill.target === 'cone'
      ? `cono de ${skill.length} m`
      : skill.radius > 0
        ? `área de ${skill.radius} m`
        : skill.target === 'self'
          ? 'a uno mismo'
          : null;
  return [area, ...parts].filter(Boolean).join(', ');
}

/**
 * Texto del tooltip de la hotbar (con lo que falta si no se puede usar).
 * `cooldown`: turnos que le quedan a una habilidad.
 */
export function hotbarTooltip(entry: HotbarEntry, enabled: boolean, cooldown = 0): string {
  const cost = COST_TEXT[entry.cost];
  let parts: string[];
  if (entry.attack) {
    const kind = entry.kind === 'melee' ? 'cuerpo a cuerpo' : 'a distancia, requiere visión';
    parts = [
      entry.name,
      cost,
      kind,
      `alcance ${entry.attack.range} m`,
      `${entry.attack.damage} daño`,
    ];
  } else if (entry.skill) {
    const s = entry.skill;
    parts = [entry.name, cost];
    if (s.range > 0) parts.push(`alcance ${s.range} m`);
    parts.push(skillEffects(s));
    if (s.cooldown > 0) parts.push(`recarga ${s.cooldown} turnos`);
  } else if (entry.kind === 'jump') {
    parts = [entry.name, 'gasta los metros saltados', 'por encima de cajas y muros bajos'];
  } else {
    parts = [entry.name, cost, 'aparta un barril o una caja adyacente'];
  }
  if (cooldown > 0) parts.push(`disponible en ${cooldown} turno${cooldown > 1 ? 's' : ''}`);
  else if (!enabled) parts.push(`sin ${cost.toLowerCase()}`);
  return parts.join(' · ');
}
