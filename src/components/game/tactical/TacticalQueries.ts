import RAPIER from '@dimforge/rapier3d';
import type { Collider } from '@dimforge/rapier3d';
import { Engine } from '../../../core/engine/Engine';
import type { vec3 } from 'gl-matrix';
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

/**
 * ¿Se puede ir andando de `from` a `to`? El punto debe estar en el navmesh y conectado:
 * zonas aisladas (p.ej. encima de una caja) están en el navmesh pero no son alcanzables.
 */
export function isReachable(from: vec3, to: vec3, tolerance = 0.3): boolean {
  if (!isOnNavMesh(to[0]!, to[1]!, to[2]!, tolerance)) return false;
  const path = AStar.findPath(from, to);
  if (!path || path.length === 0) return false;
  const end = path[path.length - 1]!;
  const dx = end[0]! - to[0]!;
  const dz = end[2]! - to[2]!;
  return dx * dx + dz * dz <= tolerance * tolerance && Math.abs(end[1]! - to[1]!) < 0.6;
}
