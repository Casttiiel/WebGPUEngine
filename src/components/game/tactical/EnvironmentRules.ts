import { vec3 } from 'gl-matrix';
import { UnitComponent } from './UnitComponent';
import { groundHeightAt, hasLineOfSight, isOnNavMesh } from './TacticalQueries';

/**
 * Reglas del entorno que no dependen del turno: la trayectoria de un salto y hasta dónde
 * llega un objeto empujado. Las usa EncounterComponent (jugador, MCP, IA).
 */

/** Distancia horizontal máxima de un salto (m). */
export const MAX_JUMP = 4.5;
/** Desnivel máximo hacia arriba (m): se puede subir a la plataforma, no a un muro. */
const MAX_RISE = 1.6;
/** Altura máxima del arco sobre la recta entre despegue y aterrizaje (m). */
const MAX_ARC = 2;
const MIN_ARC = 0.6;
/** Holgura de los pies sobre lo que se salta (m). */
const CLEARANCE = 0.3;
const ARC_SAMPLES = 24;
const ARC_POINTS = 14;

export interface JumpArc {
  /** Puntos de la trayectoria de los pies (incluye despegue y aterrizaje). */
  points: vec3[];
  /** Distancia horizontal (lo que cuesta en movimiento). */
  distance: number;
}

/**
 * Trayectoria de un salto de `from` a `to` (pies), o el motivo por el que no se puede:
 * demasiado lejos, demasiado alto, sin sitio donde aterrizar u obstáculo demasiado alto
 * en medio (columnas, muros). Las cajas y los muros bajos se saltan.
 */
export function jumpArc(from: vec3, to: vec3): JumpArc | { reason: string } {
  const dx = to[0]! - from[0]!;
  const dz = to[2]! - from[2]!;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.5) return { reason: 'too close' };
  if (distance > MAX_JUMP) return { reason: 'too far to jump' };
  if (to[1]! - from[1]! > MAX_RISE) return { reason: 'too high to jump' };
  if (!isOnNavMesh(to[0]!, to[1]!, to[2]!, 0.3)) return { reason: 'cannot land there' };

  // Altura del arco: la mínima que pasa por encima de todo lo que hay debajo.
  const y0 = from[1]!;
  const y1 = to[1]!;
  let arc = MIN_ARC;
  for (let i = 1; i < ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES;
    const top = groundHeightAt(from[0]! + dx * t, from[2]! + dz * t);
    if (top === null) continue;
    const need = top + CLEARANCE - (y0 + (y1 - y0) * t);
    if (need > 0) arc = Math.max(arc, need / (4 * t * (1 - t)));
  }
  if (arc > MAX_ARC) return { reason: 'obstacle too high' };

  const points: vec3[] = [];
  for (let i = 0; i <= ARC_POINTS; i++) {
    const t = i / ARC_POINTS;
    points.push(
      vec3.fromValues(
        from[0]! + dx * t,
        y0 + (y1 - y0) * t + arc * 4 * t * (1 - t),
        from[2]! + dz * t,
      ),
    );
  }
  return { points, distance };
}

const PUSH_STEP = 0.1;
const PUSH_HEIGHT = 0.3; // altura (sobre los pies) del rayo que busca paredes
const PUSH_GAP = 0.05;

/**
 * Hasta dónde llega `prop` empujado en la dirección `dir` (horizontal, normalizada), como
 * mucho `maxDistance`: se para contra la geometría, otras unidades u objetos, o un desnivel.
 */
export function pushDistance(prop: UnitComponent, dir: vec3, maxDistance: number): number {
  const start = prop.getFeetPosition(vec3.create());
  const radius = prop.getCapsuleRadius();
  const others = UnitComponent.getAll().filter((u) => u !== prop && u.isAlive());
  const from = vec3.fromValues(start[0]!, start[1]! + PUSH_HEIGHT, start[2]!);
  const probe = vec3.create();
  const p = vec3.create();
  const tmp = vec3.create();
  let reached = 0;
  for (let s = PUSH_STEP; s <= maxDistance + 1e-6; s += PUSH_STEP) {
    vec3.scaleAndAdd(p, start, dir, s);
    // Paredes, cajas estáticas…: rayo desde el centro hasta el borde del objeto ya movido.
    vec3.scaleAndAdd(probe, from, dir, s + radius);
    if (!hasLineOfSight(from, probe)) break;
    // El suelo sigue al mismo nivel (ni bordillos ni caídas).
    const ground = groundHeightAt(p[0]!, p[2]!, start[1]! + 0.5);
    if (ground === null || Math.abs(ground - start[1]!) > 0.15) break;
    // Otras unidades y objetos.
    const blocked = others.some((u) => {
      const q = u.getPosition(tmp);
      return Math.hypot(q[0]! - p[0]!, q[2]! - p[2]!) < radius + u.getCapsuleRadius() + PUSH_GAP;
    });
    if (blocked) break;
    reached = s;
  }
  return reached;
}
