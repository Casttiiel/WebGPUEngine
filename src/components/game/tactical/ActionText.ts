import type { UnitAttack, UnitComponent } from './UnitComponent';
import type { SkillDef } from './Skills';
import { skillDamage, statusTurns } from './CombatRules';
import type { AttributeId } from './Stats';

/**
 * Textos de ataques y habilidades para la UI (ficha del personaje, tooltips de la hotbar),
 * generados a partir de sus datos para que digan siempre lo mismo.
 */

export const COST_NAME: Record<string, string> = {
  action: 'Acción',
  bonusAction: 'Acción adicional',
  movement: 'Movimiento',
};
export const STATUS_NAME: Record<string, string> = { fear: 'Asustado', drained: 'Seco' };

/**
 * "Cuerpo a cuerpo · alcance 1.5 m · 10 de daño (6 + FUE 4) · Acción". Sin `unit`, la
 * fórmula ("6 + FUE"); el daño es el máximo (sin armadura delante).
 */
export function attackSummary(attack: UnitAttack, unit?: UnitComponent): string {
  const kind = attack.kind === 'melee' ? 'Cuerpo a cuerpo' : 'A distancia';
  const cost = COST_NAME[attack.cost ?? 'action'];
  const damage = scaledText(attack.damage, attack.scale ?? 'FUE', unit);
  return `${kind} · alcance ${fmt(attack.range)} m · ${damage} de daño · ${cost}`;
}

/** "10 (4 + POT 6)" con lanzador; "4 + POT" sin él; "4" sin escala. */
function scaledText(base: number, scale: AttributeId | undefined, unit?: UnitComponent): string {
  if (!scale) return String(base);
  if (!unit?.hasAttributes()) return unit ? String(base) : `${base} + ${scale}`;
  const value = unit.getAttribute(scale);
  return `${base + value} (${base} + ${scale} ${value})`;
}

/**
 * Qué hace una habilidad, a partir de sus datos ("Un punto a 14 m (área de 2.5 m): 10 de
 * daño…"). Con `caster`, los números de ese personaje (escala y duración por POT).
 */
export function skillMechanics(skill: SkillDef, caster?: UnitComponent): string {
  const area = skill.radius > 0 ? ` (área de ${fmt(skill.radius)} m)` : '';
  const target = {
    unit: `${skill.targets === 'ally' ? 'Un aliado' : skill.targets === 'enemy' ? 'Un enemigo' : 'Una unidad'} a ${fmt(skill.range)} m${area}`,
    point: `Un punto a ${fmt(skill.range)} m${area}`,
    cone: `Cono de ${fmt(skill.length)} m`,
    self: `Uno mismo${area}`,
  }[skill.target];
  const effects = skill.effects.map((e) => {
    switch (e.type) {
      case 'damage': {
        // Todos los efectos de daño se suman con la escala una vez: se enseña en el primero.
        const first = skill.effects.find((x) => x.type === 'damage') === e;
        if (!first) return null;
        const base = caster
          ? skillDamage(caster, skill) - (skill.scale ? caster.getAttribute(skill.scale) : 0)
          : e.amount;
        return `${scaledText(base, skill.scale, caster)} de daño`;
      }
      case 'heal':
        return `cura ${e.amount}`;
      case 'push':
        return `empuja ${fmt(e.distance)} m`;
      case 'teleport':
        return 'carga hasta allí';
      case 'surface':
        return e.surface === 'fire' ? 'deja fuego' : `deja ${e.surface}`;
      case 'status':
        return `${(STATUS_NAME[e.status] ?? e.status).toLowerCase()} ${turns(caster ? statusTurns(caster, e.turns) : e.turns)}`;
      case 'duralumin':
        return 'quema toda la Reserva: la siguiente, gratis y ×(1 + quemado / máximo)';
      case 'refill':
        return 'Seco el turno que viene; al acabarlo, la Reserva se llena';
    }
  });
  return `${target}: ${effects.filter((x) => x !== null).join(', ')}`;
}

/** "1 turno", "3 turnos". */
export function turns(n: number): string {
  return `${n} turno${n === 1 ? '' : 's'}`;
}

/** 9 → "9", 4.5 → "4.5". */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
