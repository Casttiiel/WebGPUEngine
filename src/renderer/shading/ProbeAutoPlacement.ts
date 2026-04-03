import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { NavMesh } from '../../ai/nav/NavMesh';
import { Loader } from '../../core/loaders/Loader';

export interface ProbeCandidate {
  position: [number, number, number];
  estimatedExtents: [number, number, number];
}

const CELL_SIZE = 5.0;   // metres — one probe per cell
const FLOOR_OFFSET = 1.5; // metres above navmesh floor
const EXTERIOR_RAY = 20.0; // metres — sky ray length for interior classification
const MIN_CLEARANCE = 0.6; // metres — minimum horizontal clearance from walls/objects

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

    // ── Step 1: Seed candidates from NavMesh centroids only ──────────────────
    // Centroids are guaranteed to lie on walkable geometry.
    // We do NOT expand a blind XZ grid around them — grid-expanded points can
    // fall inside columns, pillars, furniture, etc.
    const seen = new Set<string>();
    const candidates: vec3[] = [];

    const add = (x: number, y: number, z: number): void => {
      // Deduplicate on a coarse grid (CELL_SIZE resolution)
      const key = `${Math.round(x / CELL_SIZE)},${Math.round(z / CELL_SIZE)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(vec3.fromValues(x, y + FLOOR_OFFSET, z));
    };

    for (const c of navMesh.getCentroids()) {
      add(c[0], c[1], c[2]);
    }

    // ── Step 2: Filter candidates ─────────────────────────────────────────────
    // Three checks must all pass:
    //  a) Downward ray (solid=true): toi≈0 → inside a solid → reject.
    //     No hit or toi too large → not near any walkable floor → reject.
    //  b) Upward ray (solid=false): must find a ceiling → interior point.
    //     solid=false avoids false toi=0 when origin is inside geometry.
    //  c) Horizontal clearance: 4 cardinal rays at head height.
    //     Any hit within MIN_CLEARANCE → too close to a wall/object → reject.
    const physics = Engine.getPhysics();
    const up   = vec3.fromValues(0,  1, 0);
    const down = vec3.fromValues(0, -1, 0);
    const cardinals = [
      vec3.fromValues( 1, 0,  0),
      vec3.fromValues(-1, 0,  0),
      vec3.fromValues( 0, 0,  1),
      vec3.fromValues( 0, 0, -1),
    ];

    const interior: vec3[] = candidates.filter((pos) => {
      // ── a) Vertical: valid floor below, not inside solid ──────────────────
      const downHit = physics.raycast(pos, down, FLOOR_OFFSET * 3, true);
      if (!downHit) return false;                          // no floor found
      if (downHit.timeOfImpact < 0.05) return false;      // inside solid geometry
      if (downHit.timeOfImpact > FLOOR_OFFSET * 2) return false; // floor too far

      // ── b) Ceiling above → interior ───────────────────────────────────────
      const ceilHit = physics.raycast(pos, up, EXTERIOR_RAY, false);
      if (!ceilHit) return false;

      // ── c) Horizontal clearance — no wall/object within MIN_CLEARANCE ─────
      for (const dir of cardinals) {
        const wallHit = physics.raycast(pos, dir, MIN_CLEARANCE, false);
        if (wallHit !== null) return false;
      }

      return true;
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
