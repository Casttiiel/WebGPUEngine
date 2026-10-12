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
  const arc = arcPath(from, to, MAX_JUMP, MAX_RISE, MAX_ARC);
  if ('reason' in arc && arc.reason === 'too far') return { reason: 'too far to jump' };
  if ('reason' in arc && arc.reason === 'too high') return { reason: 'too high to jump' };
  return arc;
}

/** Distancia máxima a la que se lanza un objeto (m, desde quien lo lanza). */
export const THROW_RANGE = 8;
/** Lo más lejos que vuela un objeto lanzado (m, desde donde estaba hasta donde cae). */
const THROW_MAX_FLIGHT = 10;
const THROW_MAX_RISE = 3;
const THROW_MAX_ARC = 4;
/** Arco mínimo de un lanzamiento: una parábola que se vea, más alta cuanto más lejos. */
const THROW_MIN_ARC = 1;
const THROW_ARC_PER_METER = 0.25;

/**
 * Trayectoria de un objeto lanzado de `from` a `to` (en arco, por encima de lo que haya en
 * medio), o el motivo por el que no se puede: lejos, alto, sin sitio donde caer, o algo
 * demasiado alto en medio.
 */
export function throwArc(from: vec3, to: vec3): JumpArc | { reason: string } {
  const distance = Math.hypot(to[0]! - from[0]!, to[2]! - from[2]!);
  const minArc = Math.min(THROW_MAX_ARC, Math.max(THROW_MIN_ARC, distance * THROW_ARC_PER_METER));
  const arc = arcPath(from, to, THROW_MAX_FLIGHT, THROW_MAX_RISE, THROW_MAX_ARC, minArc);
  if ('reason' in arc && arc.reason === 'too far') return { reason: 'too far to throw' };
  if ('reason' in arc && arc.reason === 'too high') return { reason: 'too high to throw' };
  return arc;
}

/** Arco parabólico de `from` a `to` que pasa por encima de todo lo que hay debajo. */
function arcPath(
  from: vec3,
  to: vec3,
  maxDistance: number,
  maxRise: number,
  maxArc: number,
  minArc = MIN_ARC,
): JumpArc | { reason: string } {
  const dx = to[0]! - from[0]!;
  const dz = to[2]! - from[2]!;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.5) return { reason: 'too close' };
  if (distance > maxDistance) return { reason: 'too far' };
  if (to[1]! - from[1]! > maxRise) return { reason: 'too high' };
  if (!isOnNavMesh(to[0]!, to[1]!, to[2]!, 0.3)) return { reason: 'cannot land there' };

  // Altura del arco: la mínima que pasa por encima de todo lo que hay debajo. La holgura es
  // completa a mitad de salto y se reduce a cero en el despegue y el aterrizaje (4t(1-t)):
  // al subir a una plataforma, los últimos centímetros van sobre ella misma y no tiene que
  // haber 30 cm de aire bajo los pies justo al tocar el suelo.
  const y0 = from[1]!;
  const y1 = to[1]!;
  let arc = minArc;
  for (let i = 1; i < ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES;
    const top = groundHeightAt(from[0]! + dx * t, from[2]! + dz * t);
    if (top === null) continue;
    const bump = 4 * t * (1 - t);
    const need = top + CLEARANCE * bump - (y0 + (y1 - y0) * t);
    if (need > 0) arc = Math.max(arc, need / bump);
  }
  if (arc > maxArc) return { reason: 'obstacle too high' };

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
  return pushPath(prop, dir, maxDistance).length;
}

/**
 * Como pushDistance, y además la unidad u objeto contra el que choca (null si se para contra
 * una pared, un desnivel o simplemente llega al final): el que recibe el impacto. `ignore`: quien
 * empuja (se pondrá detrás; donde está ahora no estorba).
 */
export function pushPath(
  prop: UnitComponent,
  dir: vec3,
  maxDistance: number,
  ignore: UnitComponent | null = null,
): { length: number; hit: UnitComponent | null } {
  const start = prop.getFeetPosition(vec3.create());
  const radius = prop.getCapsuleRadius();
  const others = UnitComponent.getAll().filter((u) => u !== prop && u !== ignore && u.isAlive());
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
    const blocker = others.find((u) => {
      const q = u.getPosition(tmp);
      return Math.hypot(q[0]! - p[0]!, q[2]! - p[2]!) < radius + u.getCapsuleRadius() + PUSH_GAP;
    });
    if (blocker) return { length: reached, hit: blocker };
    reached = s;
  }
  return { length: reached, hit: null };
}

/**
 * Primera unidad u objeto contra el que choca `prop` volando por `points` (sus pies), sin
 * contar `ignore` (quien lo lanza). Si choca, el vuelo se corta y cae al suelo justo antes
 * del golpe (`points` acaba ahí); si no, aterriza donde iba.
 */
export function flightHit(
  prop: UnitComponent,
  points: vec3[],
  ignore: UnitComponent | null,
): { points: vec3[]; hit: UnitComponent | null } {
  const radius = prop.getCapsuleRadius();
  const height = prop.getFeetOffset() * 2;
  const others = UnitComponent.getAll().filter((u) => u !== prop && u !== ignore && u.isAlive());
  const feet = vec3.create();
  const apart = (p: vec3, u: UnitComponent) => {
    u.getFeetPosition(feet);
    return Math.hypot(p[0]! - feet[0]!, p[2]! - feet[2]!) >= radius + u.getCapsuleRadius();
  };
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const hit = others.find((u) => {
      if (apart(p, u)) return false;
      const bottom = u.getFeetPosition(feet)[1]!;
      return p[1]! < bottom + u.getFeetOffset() * 2 && p[1]! + height > bottom;
    });
    if (!hit) continue;
    // Cae en vertical desde el último punto que no está encima de lo que ha golpeado.
    let j = i - 1;
    while (j > 0 && !apart(points[j]!, hit)) j--;
    const last = points[j]!;
    const ground =
      groundHeightAt(last[0]!, last[2]!, last[1]! + 0.5) ?? hit.getFeetPosition(feet)[1]!;
    const fall = vec3.fromValues(last[0]!, ground, last[2]!);
    return { points: [...points.slice(0, j + 1), fall], hit };
  }
  return { points, hit: null };
}
