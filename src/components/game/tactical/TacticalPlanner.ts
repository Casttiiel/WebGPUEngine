import { vec3 } from 'gl-matrix';
import type { Entity } from '../../../core/ecs/Entity';
import type { EncounterComponent } from './EncounterComponent';
import type { UnitAttack, UnitComponent } from './UnitComponent';
import { previewAttack, unitDistanceFrom, unitLineOfSightFrom } from './CombatRules';

export type AIRole = 'melee' | 'ranged';

/** Cómo juega una unidad de la IA. */
export interface AIProfile {
  role: AIRole;
  /** Por debajo de esta fracción de vida prefiere retirarse (0 = nunca). */
  retreatHp: number;
  /** A distancia: separación que intenta mantener con el enemigo más cercano (m). */
  preferredDistance: number;
}

export type TurnPlanKind = 'attack' | 'reposition' | 'retreat' | 'advance' | 'wait';

/** Lo que la IA hará este turno: moverse (opcional) y después atacar (opcional). */
export interface TurnPlan {
  kind: TurnPlanKind;
  /** Moverse aquí primero (punto del suelo). Si no cabe en el movimiento, avanza lo que pueda. */
  move: vec3 | null;
  /** Después, atacar (requestAttack: el cuerpo a cuerpo se acerca solo si hace falta). */
  attack: { target: Entity; attackId: string } | null;
  score: number;
  /** Explicación legible (debug / MCP). */
  reason: string;
}

// Pesos de la puntuación. Una unidad de "valor" ≈ un punto de daño esperado.
const ATTACK_BASE = 10;
const KILL_BONUS = 12;
const FOCUS_WOUNDED = 4;
const MOVE_COST = 0.15; // por metro andado
const RANGED_KEEP_DISTANCE = 0.6; // por metro de separación (hasta preferredDistance)
const RANGED_IN_MELEE_PENALTY = 6;
const LOW_HP_ATTACK_FACTOR = 0.4;
const RETREAT_BASE = 8;
const RETREAT_DISTANCE = 1.2; // por metro de separación del enemigo más cercano
const RETREAT_HIDDEN = 5; // ningún enemigo le ve
const ADVANCE_BASE = -20;
const MELEE_REACH = 2; // de borde a borde: "le pueden pegar" si está más cerca

const RING_STEP = 1.5;
const RING_ANGLES = 12;
const APPROACH_ANGLES = 12;

interface Sample {
  feet: vec3;
  length: number;
}

/**
 * TacticalPlanner — decide el turno de una unidad de la IA puntuando candidatos con las
 * mismas reglas que usa el jugador (EncounterComponent.planAttack / planMove):
 *
 *  - atacar desde donde está, o acercarse y atacar cuerpo a cuerpo,
 *  - moverse a un sitio con alcance y línea de visión y disparar (a distancia),
 *  - retirarse lejos y fuera de la vista de la party si está baja de vida,
 *  - avanzar hacia el enemigo más cercano si no llega a nadie,
 *  - esperar si no hay nada que hacer.
 *
 * Para cada objetivo se valora el daño esperado (% de impacto × daño), si lo remata, si
 * ya está herido, cuánto hay que andar y dónde se queda la unidad después.
 */
export function planTurn(
  encounter: EncounterComponent,
  me: UnitComponent,
  profile: AIProfile,
): TurnPlan {
  const self = me.getOwner();
  const foes = encounter
    .getCombatantUnits()
    .filter(
      (u) => u.isAlive() && u.getFaction() !== me.getFaction() && u.getFaction() !== 'neutral',
    );
  const wait: TurnPlan = {
    kind: 'wait',
    move: null,
    attack: null,
    score: -1000,
    reason: 'nothing to do',
  };
  if (foes.length === 0) return wait;

  const low =
    profile.retreatHp > 0 && me.getMaxHp() > 0 && me.getHp() / me.getMaxHp() < profile.retreatHp;
  const resources = encounter.getResources();
  const candidates: TurnPlan[] = [wait];
  const here = me.getFeetPosition(vec3.create());

  const attackValue = (target: UnitComponent, attack: UnitAttack): number => {
    const roll = previewAttack(me, target, attack);
    const kill = roll.damage >= target.getHp();
    let value =
      ATTACK_BASE +
      roll.hitChance * roll.damage +
      (kill ? KILL_BONUS : 0) +
      (1 - target.getHp() / Math.max(1, target.getMaxHp())) * FOCUS_WOUNDED;
    if (low && !kill) value *= LOW_HP_ATTACK_FACTOR;
    return value;
  };

  /** Valor de quedarse en `feet` después de actuar (separación, a la vista o no…). */
  const positionValue = (feet: vec3): number => {
    const nearest = Math.min(...foes.map((f) => unitDistanceFrom(me, feet, f)));
    let value = 0;
    if (profile.role === 'ranged') {
      value += Math.min(nearest, profile.preferredDistance) * RANGED_KEEP_DISTANCE;
      if (nearest < MELEE_REACH) value -= RANGED_IN_MELEE_PENALTY;
    }
    if (low) {
      value += nearest * RETREAT_DISTANCE;
      if (!foes.some((f) => unitLineOfSightFrom(me, feet, f))) value += RETREAT_HIDDEN;
    }
    return value;
  };

  // 1) Atacar desde aquí, o acercarse y atacar (cuerpo a cuerpo).
  for (const foe of foes) {
    for (const attack of me.getAttacks()) {
      const plan = encounter.planAttack(self, foe.getOwner(), attack.id);
      if (!plan.canAttack) continue;
      const walk = plan.approach?.walk;
      const end = walk ? walk.points[walk.points.length - 1]! : here;
      candidates.push({
        kind: 'attack',
        move: null,
        attack: { target: foe.getOwner(), attackId: attack.id },
        score: attackValue(foe, attack) - (walk?.length ?? 0) * MOVE_COST + positionValue(end),
        reason: `${attack.name} → ${foe.getDisplayName()}${walk ? ` (acercándose ${walk.length.toFixed(1)} m)` : ''}`,
      });
    }
  }

  // 2) Moverse a otro sitio: para disparar desde allí o para retirarse.
  const ranged = me.getAttacks().filter((a) => a.kind === 'ranged');
  const canSpend = (a: UnitAttack) => resources[a.cost ?? 'action'] > 0;
  if (resources.movement > 0.5 && (low || ranged.some(canSpend))) {
    for (const sample of sampleReachable(encounter, self, here, resources.movement)) {
      const position = positionValue(sample.feet) - sample.length * MOVE_COST;
      let best: TurnPlan | null = null;
      for (const attack of ranged) {
        if (!canSpend(attack)) continue;
        for (const foe of foes) {
          if (unitDistanceFrom(me, sample.feet, foe) > attack.range) continue;
          if (!unitLineOfSightFrom(me, sample.feet, foe)) continue;
          const score = attackValue(foe, attack) + position;
          if (!best || score > best.score) {
            best = {
              kind: 'reposition',
              move: sample.feet,
              attack: { target: foe.getOwner(), attackId: attack.id },
              score,
              reason: `moverse ${sample.length.toFixed(1)} m y ${attack.name} → ${foe.getDisplayName()}`,
            };
          }
        }
      }
      if (best) candidates.push(best);
      if (low) {
        candidates.push({
          kind: 'retreat',
          move: sample.feet,
          attack: null,
          score: RETREAT_BASE + position,
          reason: `retirarse ${sample.length.toFixed(1)} m (vida baja)`,
        });
      }
    }
  }

  // 3) Nadie a su alcance: avanzar hacia el enemigo más cercano (lo que dé el movimiento).
  if (resources.movement > 0.5) {
    let best: TurnPlan | null = null;
    for (const foe of foes) {
      const approach = closestApproach(encounter, self, me, foe);
      if (!approach) continue;
      const score = ADVANCE_BASE - approach.length * 0.1;
      if (!best || score > best.score) {
        best = {
          kind: 'advance',
          move: approach.feet,
          attack: null,
          score,
          reason: `avanzar hacia ${foe.getDisplayName()} (${approach.length.toFixed(1)} m)`,
        };
      }
    }
    if (best) candidates.push(best);
  }

  return candidates.reduce((a, b) => (b.score > a.score ? b : a));
}

/** Puntos a los que puede llegar andando este turno (anillos alrededor de la unidad). */
function sampleReachable(
  encounter: EncounterComponent,
  self: Entity,
  here: vec3,
  budget: number,
): Sample[] {
  const out: Sample[] = [];
  for (let r = RING_STEP; r <= budget + 1e-3; r += RING_STEP) {
    for (let i = 0; i < RING_ANGLES; i++) {
      // Anillos alternos desfasados: cubren mejor el área.
      const angle = ((i + (r / RING_STEP) * 0.5) / RING_ANGLES) * Math.PI * 2;
      const point = vec3.fromValues(
        here[0]! + Math.cos(angle) * r,
        here[1]!,
        here[2]! + Math.sin(angle) * r,
      );
      const move = encounter.planMove(self, point);
      if (!move.canMove || !move.affordable) continue;
      const end = move.plan.points[move.plan.points.length - 1]!;
      out.push({ feet: vec3.clone(end), length: move.plan.length });
    }
  }
  return out;
}

/** Punto junto a `foe` con el camino más corto (aunque no quepa en el movimiento del turno). */
function closestApproach(
  encounter: EncounterComponent,
  self: Entity,
  me: UnitComponent,
  foe: UnitComponent,
): Sample | null {
  const center = foe.getFeetPosition(vec3.create());
  const reach = me.getCapsuleRadius() + foe.getCapsuleRadius() + 0.9;
  let best: Sample | null = null;
  for (let i = 0; i < APPROACH_ANGLES; i++) {
    const angle = (i / APPROACH_ANGLES) * Math.PI * 2;
    const point = vec3.fromValues(
      center[0]! + Math.cos(angle) * reach,
      center[1]!,
      center[2]! + Math.sin(angle) * reach,
    );
    const move = encounter.planMove(self, point);
    if (!move.plan.reachable || !move.canMove) continue;
    if (!best || move.plan.length < best.length) best = { feet: point, length: move.plan.length };
  }
  return best;
}
