import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { NavMesh } from '../../ai/nav/NavMesh';
import { Loader } from '../../core/loaders/Loader';

export interface ProbeCandidate {
  position: [number, number, number];
  estimatedExtents: [number, number, number];
}

const CELL_SIZE = 5.0; // metres — one probe per cell
const GRID_STEP = 3.0; // metres — extra grid coverage around centroids
const FLOOR_OFFSET = 1.5; // metres above navmesh floor
const EXTERIOR_RAY = 20.0; // metres — sky ray length for interior classification

/**
 * ProbeAutoPlacement — offline debug tool (FASE 3).
 *
 * Activated by setting "debugProbeAutoPlace": true in environment.json.
 * Never runs in release builds.
 *
 * Algorithm:
 *  1. Sample the NavMesh centroids + a 3-metre grid around each centroid.
 *  2. Cast a ray straight up from each candidate. If the ray hits geometry
 *     within EXTERIOR_RAY metres the point is INTERIOR (under a roof).
 *  3. Cluster interior candidates into 5×5×5 m³ cells — one probe per cell
 *     at the cluster centroid.
 *  4. Print the resulting JSON to the console. The artist places bake
 *     cameras at these positions in Blender and exports the cubemaps.
 */
export class ProbeAutoPlacement {
  public static generate(): ProbeCandidate[] {
    const navMesh = NavMesh.getInstance();
    if (!navMesh.isBuilt()) {
      console.warn('[ProbeAutoPlacement] NavMesh not built — no probes generated.');
      return [];
    }

    // ── Step 1: Seed candidates ───────────────────────────────────────────────
    const seen = new Set<string>();
    const candidates: vec3[] = [];

    const add = (x: number, y: number, z: number): void => {
      // Deduplicate on a coarse grid (GRID_STEP resolution)
      const key = `${Math.round(x / GRID_STEP)},${Math.round(z / GRID_STEP)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(vec3.fromValues(x, y + FLOOR_OFFSET, z));
    };

    for (const c of navMesh.getCentroids()) {
      add(c[0], c[1], c[2]);
      for (let dx = -GRID_STEP; dx <= GRID_STEP; dx += GRID_STEP) {
        for (let dz = -GRID_STEP; dz <= GRID_STEP; dz += GRID_STEP) {
          if (dx === 0 && dz === 0) continue;
          add(c[0] + dx, c[1], c[2] + dz);
        }
      }
    }

    // ── Step 2: Classify interior vs exterior via upward raycast ─────────────
    const physics = Engine.getPhysics();
    const up = vec3.fromValues(0, 1, 0);

    const interior: vec3[] = candidates.filter((pos) => {
      const hit = physics.raycast(pos, up, EXTERIOR_RAY, true);
      return hit !== null; // has ceiling → interior
    });

    // ── Step 3: Cluster into CELL_SIZE³ cells ────────────────────────────────
    const cellMap = new Map<string, vec3[]>();

    for (const pos of interior) {
      const cx = Math.floor(pos[0] / CELL_SIZE);
      const cy = Math.floor(pos[1] / CELL_SIZE);
      const cz = Math.floor(pos[2] / CELL_SIZE);
      const key = `${cx},${cy},${cz}`;
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key)!.push(pos);
    }

    // ── Step 4: One probe per cell at the cluster centroid ────────────────────
    const probes: ProbeCandidate[] = [];

    for (const [, group] of cellMap) {
      const pos = vec3.create();
      for (const p of group) vec3.add(pos, pos, p);
      vec3.scale(pos, pos, 1 / group.length);

      probes.push({
        position: [pos[0], pos[1], pos[2]],
        estimatedExtents: [CELL_SIZE / 2, CELL_SIZE / 2, CELL_SIZE / 2],
      });
    }

    console.log(`[ProbeAutoPlacement] Spawning ${probes.length} reflection probes...`);

    for (let i = 0; i < probes.length; i++) {
      const p = probes[i]!;
      const entityJson = {
        prefab: 'lighting/reflection_probe.prefab',
        components: {
          name: `ReflectionProbe_Auto_${i}`,
          transform: {
            position: p.position,
          },
          reflection_probe: {
            resolution: 512,
            extents: p.estimatedExtents,
          },
        },
      };

      Loader.parseEntityFromJSON(entityJson as any).then((parsed) =>
        Loader.loadEntityFromJSON(parsed),
      );
    }

    return probes;
  }
}
