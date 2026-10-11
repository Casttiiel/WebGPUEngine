import RAPIER from '@dimforge/rapier3d';
import type { Collider } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import { vec3 } from 'gl-matrix';
import { NavMesh } from '../../../ai/nav/NavMesh';
import { AStar } from '../../../ai/nav/AStar';

/**
 * Consultas espaciales compartidas por los sistemas tácticos (cámara, selección, cursor).
 * "Estático" = colliders de cuerpos fijos, sin sensores: el mapa, no las unidades.
 */

const isStaticSolid = (collider: Collider): boolean =>
  !collider.isSensor() && (collider.parent()?.isFixed() ?? true);

/**
 * Altura de la geometría estática bajo (x, z). Con `fromY` el rayo sale desde esa altura
 * (p.ej. el centro de una unidad: encuentra la plataforma sobre la que está); sin él,
 * desde muy arriba (la superficie más alta: encima de muros y cajas).
 */
export function groundHeightAt(x: number, z: number, fromY = 200): number | null {
  const world = Engine.getPhysics()?.getWorld();
  if (!world) return null;
  const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(
    ray,
    fromY + 200,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    isStaticSolid,
  );
  return hit ? fromY - hit.timeOfImpact : null;
}

/** ¿Es (x, y, z) un punto transitable del navmesh? (tolerancia horizontal/vertical en m). */
export function isOnNavMesh(x: number, y: number, z: number, tolerance = 0.25): boolean {
  const query = NavMesh.getInstance().getQuery();
  if (!query) return false;
  const result = query.findClosestPoint(
    { x, y, z },
    { halfExtents: { x: tolerance, y: 0.5, z: tolerance } },
  );
  if (!result.success || !result.polyRef) return false;
  const dx = result.point.x - x;
  const dz = result.point.z - z;
  return dx * dx + dz * dz <= tolerance * tolerance && Math.abs(result.point.y - y) < 0.5;
}

export interface PathPlan {
  /** Puntos del camino sobre el suelo (incluye inicio y fin). Vacío si no hay camino. */
  points: vec3[];
  /** Longitud del camino en metros. */
  length: number;
  /** El camino llega al destino pedido (no se queda en el punto alcanzable más cercano). */
  reachable: boolean;
}

/**
 * Camino andando de `from` a `to` por el navmesh (con los obstáculos dinámicos actuales).
 * Zonas aisladas (p.ej. encima de una caja) o tapadas por otras unidades no son alcanzables.
 */
export function planPath(from: vec3, to: vec3, tolerance = 0.3): PathPlan {
  const empty: PathPlan = { points: [], length: 0, reachable: false };
  if (!isOnNavMesh(to[0]!, to[1]!, to[2]!, tolerance)) return empty;
  const points = AStar.findPath(from, to);
  if (!points || points.length === 0) return empty;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  }
  const end = points[points.length - 1]!;
  const dx = end[0]! - to[0]!;
  const dz = end[2]! - to[2]!;
  const reachable = dx * dx + dz * dz <= tolerance * tolerance && Math.abs(end[1]! - to[1]!) < 0.6;
  return { points, length, reachable };
}

export function isReachable(from: vec3, to: vec3, tolerance = 0.3): boolean {
  return planPath(from, to, tolerance).reachable;
}

/** ¿Hay línea de visión entre dos puntos? Solo bloquea la geometría estática. */
export function hasLineOfSight(a: vec3, b: vec3): boolean {
  const world = Engine.getPhysics()?.getWorld();
  if (!world) return false;
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const dz = b[2]! - a[2]!;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const ray = new RAPIER.Ray(
    { x: a[0]!, y: a[1]!, z: a[2]! },
    { x: dx / dist, y: dy / dist, z: dz / dist },
  );
  const hit = world.castRay(
    ray,
    dist,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    isStaticSolid,
  );
  return hit === null;
}

/**
 * Recorta un camino a `maxLength` metros: mismo recorrido, terminando en el punto más
 * lejano alcanzable. Los puntos intermedios de un camino de Detour están sobre el navmesh.
 */
export function truncatePath(points: vec3[], maxLength: number): PathPlan {
  const out: vec3[] = [];
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i === 0) {
      out.push(vec3.clone(p));
      continue;
    }
    const prev = points[i - 1]!;
    const segment = vec3.distance(prev, p);
    if (length + segment <= maxLength) {
      out.push(vec3.clone(p));
      length += segment;
      continue;
    }
    const t = (maxLength - length) / segment;
    if (t > 1e-3) out.push(vec3.lerp(vec3.create(), prev, p, t));
    length = maxLength;
    break;
  }
  return { points: out, length, reachable: out.length >= 2 };
}
