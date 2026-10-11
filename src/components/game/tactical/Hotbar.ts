import type { UnitAttack, UnitComponent } from './UnitComponent';

export type HotbarKind = 'melee' | 'ranged' | 'jump' | 'push';
export type HotbarCost = 'action' | 'bonusAction' | 'movement';

/** Una entrada de la hotbar: un ataque o una acción de entorno. */
export interface HotbarEntry {
  /** Id que se arma en el puntero: el del ataque, 'jump' o 'push'. */
  id: string;
  name: string;
  kind: HotbarKind;
  cost: HotbarCost;
  attack: UnitAttack | null;
}

const ABILITIES: Record<'jump' | 'push', Omit<HotbarEntry, 'attack'>> = {
  jump: { id: 'jump', name: 'Saltar', kind: 'jump', cost: 'movement' },
  push: { id: 'push', name: 'Empujar', kind: 'push', cost: 'bonusAction' },
};

/** Ataques de la unidad (en su orden) y después sus acciones de entorno. */
export function hotbarEntries(unit: UnitComponent): HotbarEntry[] {
  return [
    ...unit.getAttacks().map(
      (a): HotbarEntry => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        cost: a.cost ?? 'action',
        attack: a,
      }),
    ),
    ...unit.getAbilities().map((ability): HotbarEntry => ({ ...ABILITIES[ability], attack: null })),
  ];
}

export function isAbilityId(id: string | null): id is 'jump' | 'push' {
  return id === 'jump' || id === 'push';
}

const COST_TEXT: Record<HotbarCost, string> = {
  action: 'Acción',
  bonusAction: 'Acción adicional',
  movement: 'Movimiento',
};

/** Texto del tooltip de la hotbar (con lo que falta si no se puede usar). */
export function hotbarTooltip(entry: HotbarEntry, enabled: boolean): string {
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
  } else if (entry.kind === 'jump') {
    parts = [entry.name, 'gasta los metros saltados', 'por encima de cajas y muros bajos'];
  } else {
    parts = [entry.name, cost, 'aparta un barril o una caja adyacente'];
  }
  if (!enabled) parts.push(`sin ${cost.toLowerCase()}`);
  return parts.join(' · ');
}
