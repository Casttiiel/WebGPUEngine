import type { UnitAttack } from './UnitComponent';
import type { SkillDef } from './Skills';

/**
 * Textos de ataques y habilidades para la UI (ficha del personaje, tooltips de la hotbar),
 * generados a partir de sus datos para que digan siempre lo mismo.
 */

export const COST_NAME: Record<string, string> = {
  action: 'Acción',
  bonusAction: 'Acción adicional',
  movement: 'Movimiento',
};
export const STATUS_NAME: Record<string, string> = { fear: 'Asustado' };

/** "Cuerpo a cuerpo · alcance 1.5 m · 10 de daño · Acción". */
export function attackSummary(attack: UnitAttack): string {
  const kind = attack.kind === 'melee' ? 'Cuerpo a cuerpo' : 'A distancia';
  const cost = COST_NAME[attack.cost ?? 'action'];
  return `${kind} · alcance ${fmt(attack.range)} m · ${attack.damage} de daño · ${cost}`;
}

/** Qué hace una habilidad, a partir de sus datos ("Un punto a 14 m (área de 2.5 m): 10 de daño…"). */
export function skillMechanics(skill: SkillDef): string {
  const area = skill.radius > 0 ? ` (área de ${fmt(skill.radius)} m)` : '';
  const target = {
    unit: `${skill.targets === 'ally' ? 'Un aliado' : skill.targets === 'enemy' ? 'Un enemigo' : 'Una unidad'} a ${fmt(skill.range)} m${area}`,
    point: `Un punto a ${fmt(skill.range)} m${area}`,
    cone: `Cono de ${fmt(skill.length)} m`,
    self: `Uno mismo${area}`,
  }[skill.target];
  const effects = skill.effects.map((e) => {
    switch (e.type) {
      case 'damage':
        return `${e.amount} de daño`;
      case 'heal':
        return `cura ${e.amount}`;
      case 'push':
        return `empuja ${fmt(e.distance)} m`;
      case 'teleport':
        return 'carga hasta allí';
      case 'surface':
        return e.surface === 'fire' ? 'deja fuego' : `deja ${e.surface}`;
      case 'status':
        return `${(STATUS_NAME[e.status] ?? e.status).toLowerCase()} ${turns(e.turns)}`;
    }
  });
  return `${target}: ${effects.join(', ')}`;
}

/** "1 turno", "3 turnos". */
export function turns(n: number): string {
  return `${n} turno${n === 1 ? '' : 's'}`;
}

/** 9 → "9", 4.5 → "4.5". */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
