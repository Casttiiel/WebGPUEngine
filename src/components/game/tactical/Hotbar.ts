import type { UnitAttack, UnitComponent } from './UnitComponent';
import { SkillCatalog, isAnchoredBubble, isMetalAction, type SkillDef } from './Skills';
import { RHYTHM_MAX, RHYTHM_STEP } from './UnitComponent';
import { Zones } from './Zones';
import { COST_NAME, attackSummary, fmt, skillMechanics, turns } from './ActionText';
import { MAX_JUMP, THROW_RANGE } from './EnvironmentRules';

export type HotbarKind = 'melee' | 'ranged' | 'jump' | 'push' | 'throw' | 'skill' | 'passive';
export type HotbarCost = 'action' | 'bonusAction' | 'movement' | 'free';

/** Una entrada de la hotbar: un ataque, una acción de entorno o una habilidad. */
export interface HotbarEntry {
  /** Id que se arma en el puntero: el del ataque, 'jump', 'push', 'throw' o el de la habilidad. */
  id: string;
  name: string;
  kind: HotbarKind;
  cost: HotbarCost;
  attack: UnitAttack | null;
  skill: SkillDef | null;
  /** Burbuja de bendaleo con la suya activa: el hueco la cierra. */
  closes?: boolean;
}

/** Id del hueco de la pasiva del Ritmo (no se arma ni se lanza). */
export const RHYTHM_ENTRY = 'rhythm';

export type AbilityId = 'jump' | 'push' | 'throw';

const ABILITIES: Record<AbilityId, Omit<HotbarEntry, 'attack' | 'skill'>> = {
  jump: { id: 'jump', name: 'Saltar', kind: 'jump', cost: 'movement' },
  push: { id: 'push', name: 'Empujar', kind: 'push', cost: 'bonusAction' },
  throw: { id: 'throw', name: 'Lanzar', kind: 'throw', cost: 'action' },
};

/**
 * Ataques de la unidad (en su orden), sus acciones de entorno y sus habilidades. El
 * duraluminio y recargar no: van junto a la barra de metal (CombatHUD).
 */
export function hotbarEntries(unit: UnitComponent): HotbarEntry[] {
  const skills = unit
    .getSkillIds()
    .map((id) => SkillCatalog.get(id))
    .filter((s): s is SkillDef => s !== null && !isMetalAction(s));
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
    ...skills.map((s): HotbarEntry => {
      // Con su burbuja activa, el hueco la cierra (sin acción).
      const closes = isAnchoredBubble(s) && Zones.ownedBy(unit) !== null;
      return {
        id: s.id,
        name: closes ? 'Cerrar burbuja' : s.name,
        kind: 'skill',
        cost: closes ? 'free' : s.cost,
        attack: null,
        skill: s,
        ...(closes && { closes }),
      };
    }),
    // La pasiva del Ritmo, con su % actual.
    ...(unit.hasRhythm()
      ? [
          {
            id: RHYTHM_ENTRY,
            name: `Ritmo +${unit.getStatus('rhythm')?.amount ?? 0} %`,
            kind: 'passive',
            cost: 'free',
            attack: null,
            skill: null,
          } satisfies HotbarEntry,
        ]
      : []),
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
  'no charges': 'No le quedan cargas',
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
  if (entry.kind === 'passive') {
    info(
      `Pasiva · +${RHYTHM_STEP} % por golpe seguido al mismo objetivo (hasta +${RHYTHM_STEP * RHYTHM_MAX} %)`,
    );
    lines.push({
      text: 'Se pierde al cambiar de objetivo, al quedar Aturdido o tras un turno sin golpear. El Remate lo gasta.',
      style: 'description',
    });
    return { title: 'Ritmo', lines };
  }
  if (entry.closes) {
    info('Sin acción · cierra tu burbuja de bendaleo ya');
    return { title: entry.name, lines };
  }
  if (entry.attack) {
    info(attackSummary(entry.attack, unit));
    if (entry.kind === 'ranged') info('Necesita línea de visión.');
  } else if (entry.skill) {
    const s = entry.skill;
    const recharge = s.cooldown > 0 ? ` · recarga ${turns(s.cooldown)}` : '';
    const metal = s.metal > 0 ? ` · ${s.metal} de metal` : '';
    const charge = s.charge
      ? ` · 1 carga (quedan ${unit?.getCharges(s.charge) ?? 0} de ${unit?.getMaxCharges(s.charge) ?? 0})`
      : '';
    info(`${COST_NAME[s.cost]}${metal}${charge}${recharge}${s.allomantic ? ' · alomancia' : ''}`);
    info(skillMechanics(s, unit));
    if (s.description) lines.push({ text: s.description, style: 'description' });
  } else if (entry.kind === 'jump') {
    info(`Movimiento · hasta ${fmt(MAX_JUMP)} m, gasta los metros saltados`);
    lines.push({ text: 'Por encima de cajas y muros bajos.', style: 'description' });
  } else if (entry.kind === 'push') {
    info(`${COST_NAME.bonusAction} · elige un objeto y hacia dónde: sale en línea recta`);
    info('Daño de impacto a quien pille (el objeto también lo recibe)');
    lines.push({ text: 'Desliza un objeto Grande (una caja, un barril).', style: 'description' });
  } else {
    info(
      `${COST_NAME.action} · elige un objeto Pequeño y dónde lanzarlo (hasta ${fmt(THROW_RANGE)} m)`,
    );
    info('Vuela en arco; daño de impacto (6 + FUE) a quien golpee');
    lines.push({
      text: 'Cuchillos, clavos, monedas: lo que quepa en la mano.',
      style: 'description',
    });
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
