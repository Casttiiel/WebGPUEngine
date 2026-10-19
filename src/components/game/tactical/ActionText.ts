import type { UnitAttack, UnitComponent } from './UnitComponent';
import type { SkillDef } from './Skills';
import { skillDamage } from './CombatRules';
import { steelDistanceFor, steelJumpFor, type AttributeId } from './Stats';

/**
 * Textos de ataques y habilidades para la UI (ficha del personaje, tooltips de la hotbar),
 * generados a partir de sus datos para que digan siempre lo mismo.
 */

export const COST_NAME: Record<string, string> = {
  action: 'Acción',
  bonusAction: 'Acción adicional',
  movement: 'Movimiento',
  free: 'Sin acción',
};
export const STATUS_NAME: Record<string, string> = {
  fear: 'Asustado',
  drained: 'Seco',
  stunned: 'Aturdido',
  prone: 'Derribado',
  marked: 'Marcado',
  steel_bubble: 'Burbuja de acero',
  iron_light: 'Ligero',
  iron_heavy: 'Pesado',
  rhythm: 'Ritmo',
  pewter: 'Peltre avivado',
  pewter_drag: 'Arrastre de peltre',
  gold_heal: 'Mente de oro',
};

/** Qué hace cada estado (tooltips, ficha). */
export const STATUS_HELP: Record<string, string> = {
  fear: 'no ataca y huye',
  drained: 'sin alomancia; al acabar el turno, la Reserva se llena',
  stunned: 'pierde su próxima Acción',
  prone: 'levantarse cuesta la mitad del movimiento; el melee contra él es crítico',
  marked: 'el siguiente golpe que recibe hace más daño',
  steel_bubble: 'los proyectiles contra él tienen un 50 % de fallar',
  iron_light: 'sus saltos llegan el doble',
  iron_heavy: 'no le pueden empujar, atraer ni derribar',
  rhythm: 'sus golpes contra el mismo objetivo hacen más daño',
  pewter: '+3 m de movimiento, inmune a Derribado y Aturdido, +20 % de daño',
  pewter_drag: '−50 % de movimiento y de daño',
  gold_heal: 'se cura al empezar cada turno',
};

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
    unit: `${skill.targets === 'ally' ? 'Un aliado' : skill.targets === 'enemy' ? 'Un enemigo' : 'Una unidad'} a ${skill.minRange > 0 ? `${fmt(skill.minRange)}–` : ''}${fmt(skill.range)} m${area}`,
    point: skill.effects.some((e) => e.type === 'leap')
      ? 'Un punto'
      : `Un punto a ${fmt(skill.range)} m${area}`,
    cone: `Cono de ${fmt(skill.length)} m`,
    line: `Línea de ${fmt(skill.length)} m`,
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
        const pen = e.penetration ? ` (+${e.penetration} de penetración)` : '';
        return `${scaledText(base, skill.scale, caster)} de daño${pen}`;
      }
      case 'heal':
        return `cura ${e.amount}`;
      case 'push':
        return `empuja ${fmt(e.distance)} m`;
      case 'teleport':
        return 'carga hasta allí';
      case 'surface':
        return e.surface === 'fire' ? 'deja fuego' : `deja ${e.surface}`;
      case 'status': {
        const name = (STATUS_NAME[e.status] ?? e.status).toLowerCase();
        const scale = skill.scale && caster?.hasAttributes() ? caster.getAttribute(skill.scale) : 0;
        const amount =
          e.amount !== undefined
            ? caster?.hasAttributes() || !e.amountPerPoint
              ? ` +${e.amount + (e.amountPerPoint ?? 0) * scale} %`
              : ` +${e.amount} % + ${e.amountPerPoint} % por ${skill.scale}`
            : '';
        const time = e.untilTurnStart ? 'hasta tu siguiente turno' : turns(e.turns);
        return `${name}${amount} ${time}`;
      }
      case 'steelPush':
        return `lo metálico sale despedido ${distanceText(steelDistanceFor, caster)} (desviable ±${fmt((e.aimAngle ?? 40) / 2)}°)`;
      case 'ironPull':
        return `atrae lo metálico ${distanceText(steelDistanceFor, caster)} (llega Derribado; si solo lleva un arma de metal, le desarma)`;
      case 'leap':
        return `salta ${distanceText(steelJumpFor, caster)} sin gastar movimiento`;
      case 'hurl': {
        const fue = caster?.hasAttributes() ? `${10 + caster.getAttribute('FUE')}` : '10 + FUE';
        return `lo lanzas en arco hasta ${fmt(e.distance)} m: ${fue} de impacto; una unidad cae Derribada`;
      }
      case 'flank':
        return 'si acabas a la espalda de un enemigo, queda Marcado';
      case 'finisher':
        return 'gasta el Ritmo: daño del arma × (1 + 0,5 por punto); con 3 puntos, Aturdido';
      case 'bubble': {
        const pot = caster?.hasAttributes() ? caster.getAttribute('POT') : null;
        const r =
          pot !== null
            ? `${fmt(e.radius + (e.radiusPerPoint ?? 0) * pot)} m`
            : `${fmt(e.radius)} m + ${fmt(e.radiusPerPoint ?? 0)} por POT`;
        return `burbuja de ${r} durante ${turns(e.rounds).replace('turno', 'ronda')}: quien acaba su turno dentro juega otro seguido; ningún proyectil cruza el borde`;
      }
      case 'duralumin':
        return 'quema toda la Reserva: la siguiente, gratis y ×(1 + quemado / máximo)';
      case 'refill':
        return 'Seco el turno que viene; al acabarlo, la Reserva se llena';
    }
  });
  return `${target}: ${effects.filter((x) => x !== null).join(', ')}`;
}

/** "4,5 m" con lanzador; la fórmula sin él. */
function distanceText(formula: typeof steelDistanceFor, caster: UnitComponent | undefined): string {
  if (caster?.hasAttributes()) return `${fmt(formula(caster.getAttributes()))} m`;
  return formula === steelJumpFor ? '6 + POT m' : '3 + POT/2 m';
}

/** "1 turno", "3 turnos". */
export function turns(n: number): string {
  return `${n} turno${n === 1 ? '' : 's'}`;
}

/** 9 → "9", 4.5 → "4.5". */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
