import { vec3 } from 'gl-matrix';
import type { CylinderObstacle } from 'recast-navigation';
import { Entity } from '../../../core/ecs/Entity';
import { NavMesh } from '../../../ai/nav/NavMesh';
import { UnitComponent } from './UnitComponent';

interface Entry {
  obstacle: CylinderObstacle;
  position: vec3;
}

const OBSTACLE_HEIGHT = 2;
const MOVE_THRESHOLD = 0.05;

/**
 * UnitObstacles — las unidades como obstáculos del navmesh (TileCache de Detour).
 *
 * Cada unidad viva tiene un cilindro que corta el navmesh, así los caminos las rodean y nadie
 * puede terminar un movimiento dentro de otra. La unidad que actúa (la que planifica y
 * se mueve) no tiene el suyo: si no, su propio cilindro le bloquearía el camino.
 */
export class UnitObstacles {
  private static entries = new Map<UnitComponent, Entry>();
  private static navMeshRef: unknown = null;
  private static readonly tmp = vec3.create();

  /**
   * Pone los obstáculos al día: todas las unidades salvo `acting`, en su posición actual.
   * Barato si nada ha cambiado (solo compara posiciones).
   */
  public static sync(acting: Entity | null): void {
    const navMesh = NavMesh.getInstance();
    if (!navMesh.supportsObstacles()) return;

    // Navmesh reconstruido: los obstáculos anteriores ya no existen.
    const ref = navMesh.getRecastNavMesh();
    if (ref !== this.navMeshRef) {
      this.navMeshRef = ref;
      this.entries.clear();
    }

    let changed = false;
    const units = UnitComponent.getAll();
    for (const unit of units) {
      const entry = this.entries.get(unit);
      // Los caídos no bloquean (se puede pasar por encima de un cadáver).
      const wanted = unit.getOwner() !== acting && !unit.isMoving() && unit.isAlive();
      if (!wanted) {
        if (entry) {
          navMesh.removeObstacle(entry.obstacle);
          this.entries.delete(unit);
          changed = true;
        }
        continue;
      }
      const feet = unit.getFeetPosition(this.tmp);
      if (entry && vec3.distance(entry.position, feet) < MOVE_THRESHOLD) continue;
      if (entry) navMesh.removeObstacle(entry.obstacle);
      // Radio de la unidad + radio del agente: así dos cápsulas nunca se solapan.
      const radius = unit.getCapsuleRadius() + navMesh.getAgentRadius();
      const obstacle = navMesh.addCylinderObstacle(feet, radius, OBSTACLE_HEIGHT);
      if (obstacle) this.entries.set(unit, { obstacle, position: vec3.clone(feet) });
      else this.entries.delete(unit);
      changed = true;
    }
    if (changed) navMesh.flushObstacles();
  }
}
