import { vec3 } from 'gl-matrix';
import { UnitComponent } from './UnitComponent';
import { PropComponent } from './PropComponent';
import { isOnNavMesh, staticRayDistance } from './TacticalQueries';

/**
 * Cobertura (GDD §5): tapa o no tapa, sin porcentajes.
 *
 * Es cobertura lo que es más alto que una persona agachada (COVER_HEIGHT): el escenario
 * estático alto (columnas, paredes) y los props Grandes altos (carros, cajas apiladas). Lo bajo
 * (un barril, un murete, una caja suelta) no tapa: por encima se dispara.
 *
 * Una unidad pegada a una cobertura (a menos de COVER_REACH de borde a borde) tiene una "cara"
 * hacia ella. Queda a cubierto de cualquier atacante que esté al otro lado, dentro de un arco de
 * COVER_ARC grados centrado en esa cara: no hace falta colocarse al milímetro. Los props altos
 * además cortan la línea de visión que pase a través de ellos.
 */

/** Por debajo de esta altura (m) no tapa. */
export const COVER_HEIGHT = 1.2;
/** Altura (sobre los pies) a la que se buscan las caras: por encima de lo bajo. */
const CHEST = 1.3;
/** Pegado a una cobertura: como mucho a esta distancia, de borde a borde (m). */
export const COVER_REACH = 1;
/** Arco (grados en total) que protege cada cara. */
export const COVER_ARC = 140;
/** Direcciones en las que se busca cobertura alrededor de un punto. */
const DIRECTIONS = 16;
/** Al moverse, el destino se ajusta a una cobertura a menos de esto (m, desde su borde). */
const SNAP_REACH = 1.2;
/** Hueco entre la unidad y la cobertura al ajustarse a ella (m). */
const SNAP_GAP = 0.08;

/** Una cara de cobertura: hacia dónde está (horizontal, normalizada) y a qué distancia. */
export interface CoverFace {
  dir: vec3;
  /** Distancia del centro de la unidad a la cobertura (m). */
  distance: number;
}

const tmp = vec3.create();

export class Cover {
  /** Caras ya calculadas este frame (por punto y radio). */
  private static cache = new Map<string, CoverFace[]>();

  /** Los props siguen moviéndose: las caras se recalculan cada frame. */
  public static newFrame(): void {
    this.cache.clear();
  }

  /** Props Grandes, vivos y altos: tapan. */
  public static tallProps(): UnitComponent[] {
    return UnitComponent.getAll().filter((u) => {
      const prop = PropComponent.of(u.getOwner());
      return !!prop && !prop.isSmall() && u.isAlive() && u.getFeetOffset() * 2 >= COVER_HEIGHT;
    });
  }

  /**
   * ¿Corta un prop alto el segmento de `a` a `b`? (cilindros verticales; `ignore`: el que
   * dispara y su objetivo).
   */
  public static propBlocks(a: vec3, b: vec3, ignore: UnitComponent[] = []): boolean {
    for (const prop of this.tallProps()) {
      if (ignore.includes(prop)) continue;
      const feet = prop.getFeetPosition(tmp);
      const top = feet[1]! + prop.getFeetOffset() * 2;
      const t = closestT(a, b, feet);
      const x = a[0]! + (b[0]! - a[0]!) * t;
      const z = a[2]! + (b[2]! - a[2]!) * t;
      const y = a[1]! + (b[1]! - a[1]!) * t;
      if (Math.hypot(x - feet[0]!, z - feet[2]!) <= prop.getCapsuleRadius() && y <= top) {
        return true;
      }
    }
    return false;
  }

  /**
   * Caras de cobertura de una unidad de radio `radius` con los pies en `feet`: las direcciones
   * en las que tiene, pegada, algo alto (escenario o prop alto). `ignore`: ella misma.
   */
  public static faces(
    feet: vec3,
    radius: number,
    ignore: UnitComponent | null = null,
  ): CoverFace[] {
    const key = `${feet[0]!.toFixed(2)},${feet[1]!.toFixed(2)},${feet[2]!.toFixed(2)},${radius},${ignore?.getOwner().id ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const reach = radius + COVER_REACH;
    const eye = vec3.fromValues(feet[0]!, feet[1]! + CHEST, feet[2]!);
    const props = this.tallProps().filter((p) => p !== ignore);
    const faces: CoverFace[] = [];
    for (let i = 0; i < DIRECTIONS; i++) {
      const a = (i / DIRECTIONS) * Math.PI * 2;
      const dir = vec3.fromValues(Math.cos(a), 0, Math.sin(a));
      let distance = staticRayDistance(eye, dir, reach);
      for (const p of props) distance = Math.min(distance, rayToProp(eye, dir, p, distance));
      if (distance < reach) faces.push({ dir, distance });
    }
    this.cache.set(key, faces);
    return faces;
  }

  /**
   * ¿Está a cubierto alguien de radio `radius` en `feet` frente a un atacante en `from`? Sí si
   * alguna de sus caras tiene al atacante dentro de su arco y al otro lado de la cobertura.
   */
  public static coveredAt(
    feet: vec3,
    radius: number,
    from: vec3,
    ignore: UnitComponent | null = null,
  ): boolean {
    const dx = from[0]! - feet[0]!;
    const dz = from[2]! - feet[2]!;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return false;
    const half = (COVER_ARC * Math.PI) / 360;
    return this.faces(feet, radius, ignore).some((f) => {
      if (dist <= f.distance + 0.3) return false; // está pegado a mí, a este lado
      const cos = (dx * f.dir[0]! + dz * f.dir[2]!) / dist;
      return Math.acos(Math.min(1, Math.max(-1, cos))) <= half;
    });
  }

  /** ¿Está `target` a cubierto frente a un atacante con los pies en `from`? */
  public static isCovered(target: UnitComponent, from: vec3): boolean {
    if (PropComponent.of(target.getOwner())) return false; // los objetos no se cubren
    return this.coveredAt(
      target.getFeetPosition(vec3.create()),
      target.getCapsuleRadius(),
      from,
      target,
    );
  }

  /**
   * Snap al moverse: si cerca de `point` hay una cobertura, el punto pegado a ella (en el
   * navmesh); si no, `point`.
   */
  public static snap(point: vec3, radius: number, ignore: UnitComponent | null = null): vec3 {
    const eye = vec3.fromValues(point[0]!, point[1]! + CHEST, point[2]!);
    const reach = radius + SNAP_REACH;
    const props = this.tallProps().filter((p) => p !== ignore);
    let best: { dir: vec3; distance: number } | null = null;
    for (let i = 0; i < DIRECTIONS; i++) {
      const a = (i / DIRECTIONS) * Math.PI * 2;
      const dir = vec3.fromValues(Math.cos(a), 0, Math.sin(a));
      let distance = staticRayDistance(eye, dir, reach);
      for (const p of props) distance = Math.min(distance, rayToProp(eye, dir, p, distance));
      if (distance < reach && (!best || distance < best.distance)) best = { dir, distance };
    }
    if (!best) return vec3.clone(point);
    const move = best.distance - radius - SNAP_GAP;
    if (move <= 0.02) return vec3.clone(point);
    const snapped = vec3.scaleAndAdd(vec3.create(), point, best.dir, move);
    return isOnNavMesh(snapped[0]!, snapped[1]!, snapped[2]!, 0.3) ? snapped : vec3.clone(point);
  }
}

/** Parámetro (0-1) del punto del segmento a→b más cercano a `p` en horizontal. */
function closestT(a: vec3, b: vec3, p: vec3): number {
  const dx = b[0]! - a[0]!;
  const dz = b[2]! - a[2]!;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-8) return 0;
  return Math.min(1, Math.max(0, ((p[0]! - a[0]!) * dx + (p[2]! - a[2]!) * dz) / len2));
}

/** Distancia a la que un rayo horizontal desde `eye` en `dir` toca el cilindro de un prop alto. */
export function rayToProp(eye: vec3, dir: vec3, prop: UnitComponent, max: number): number {
  const feet = prop.getFeetPosition(tmp);
  if (eye[1]! > feet[1]! + prop.getFeetOffset() * 2 || eye[1]! < feet[1]!) return max;
  const ox = eye[0]! - feet[0]!;
  const oz = eye[2]! - feet[2]!;
  const r = prop.getCapsuleRadius();
  const b = ox * dir[0]! + oz * dir[2]!;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return max;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t < max ? t : max;
}
