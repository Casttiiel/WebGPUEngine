import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { NavMesh } from '../../ai/nav/NavMesh';
import { Loader } from '../../core/loaders/Loader';

export interface ProbeCandidate {
  name: string;
  position: [number, number, number];
  estimatedExtents: [number, number, number];
  type: 'indoor' | 'outdoor';
}

const CELL_SIZE     = 5.0;  // metres — one probe per XZ cell
const FLOOR_OFFSET  = 1.5;  // metres above detected floor
const FLOOR_HEIGHT  = 3.5;  // metres — vertical scan step for multi-storey buildings
const CEIL_MAX      = 20.0; // metres — upward ray to detect ceiling (interior classification)
const MIN_CLEARANCE = 0.6;  // metres — minimum horizontal clearance from walls

const DIR_DOWN = vec3.fromValues(0, -1, 0);
const DIR_UP   = vec3.fromValues(0,  1, 0);
const CARDINALS = [
  vec3.fromValues( 1, 0,  0),
  vec3.fromValues(-1, 0,  0),
  vec3.fromValues( 0, 0,  1),
  vec3.fromValues( 0, 0, -1),
];

/**
 * ProbeAutoPlacement — places ReflectionProbe entities from scene geometry.
 *
 * Strategies (tried in order):
 *   1. NavMesh-seeded  — uses walkable triangle centroids as XZ candidates.
 *   2. Grid fallback   — XZ grid over the physics AABB, multi-Y sweep per cell.
 *
 * Call generate(sceneName) to spawn probes in the current session AND download
 * a `{sceneName}_probes.json` file ready to drop into assets/scenes/.
 */
export class ProbeAutoPlacement {

  /**
   * Places probes, awaits their entity registration, downloads placement JSON.
   * Returns the generated candidates so the caller can chain baking.
   */
  public static async generate(sceneName: string): Promise<ProbeCandidate[]> {
    const navMesh = NavMesh.getInstance();
    const seeds = navMesh.isBuilt()
      ? ProbeAutoPlacement.seedsFromNavMesh(navMesh)
      : ProbeAutoPlacement.seedsFromGrid();

    if (seeds.length === 0) {
      console.warn('[ProbeAutoPlacement] No candidate seeds — check physics/navmesh.');
      return [];
    }

    const validated = ProbeAutoPlacement.validate(seeds);
    const candidates = ProbeAutoPlacement.cluster(validated, sceneName);

    await ProbeAutoPlacement.spawn(candidates);

    console.log(
      `[ProbeAutoPlacement] Placed ${candidates.length} probes` +
      ` (${navMesh.isBuilt() ? 'NavMesh' : 'grid'} strategy).`,
    );
    return candidates;
  }

  // ── Strategy 1: NavMesh centroids ──────────────────────────────────────────

  private static seedsFromNavMesh(navMesh: NavMesh): vec3[] {
    const seen = new Set<string>();
    const out: vec3[] = [];
    for (const c of navMesh.getCentroids()) {
      const key = `${Math.round(c[0] / CELL_SIZE)},${Math.round(c[2] / CELL_SIZE)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(vec3.fromValues(c[0], c[1] + FLOOR_OFFSET, c[2]));
    }
    return out;
  }

  // ── Strategy 2: Physics AABB grid ──────────────────────────────────────────

  private static seedsFromGrid(): vec3[] {
    const physics = Engine.getPhysics();
    const { min, max } = physics.getSceneAABB();

    const seen = new Set<string>();
    const out: vec3[] = [];

    for (let x = min[0] + CELL_SIZE / 2; x < max[0]; x += CELL_SIZE) {
      for (let z = min[2] + CELL_SIZE / 2; z < max[2]; z += CELL_SIZE) {
        // Sweep Y top-to-bottom to catch every floor in multi-storey buildings
        for (let y = max[1] + 1; y >= min[1]; y -= FLOOR_HEIGHT) {
          const origin = vec3.fromValues(x, y, z);
          const hit = physics.raycast(origin, DIR_DOWN, FLOOR_HEIGHT + 0.5, true);
          if (!hit) continue;
          if (hit.timeOfImpact < 0.05) continue; // origin inside solid

          const floorY = y - hit.timeOfImpact;
          const candidate = vec3.fromValues(x, floorY + FLOOR_OFFSET, z);

          const yBand = Math.round(floorY / FLOOR_HEIGHT);
          const key = `${Math.round(x / CELL_SIZE)},${yBand},${Math.round(z / CELL_SIZE)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          out.push(candidate);
        }
      }
    }

    return out;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  private static validate(seeds: vec3[]): Array<{ pos: vec3; type: 'indoor' | 'outdoor' }> {
    const physics = Engine.getPhysics();
    const out: Array<{ pos: vec3; type: 'indoor' | 'outdoor' }> = [];

    for (const pos of seeds) {
      let tooClose = false;
      for (const dir of CARDINALS) {
        if (physics.raycast(pos, dir, MIN_CLEARANCE, false) !== null) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const ceilHit = physics.raycast(pos, DIR_UP, CEIL_MAX, false);
      out.push({ pos, type: ceilHit ? 'indoor' : 'outdoor' });
    }

    return out;
  }

  // ── Cluster into CELL_SIZE³ cells — one probe per cell at the centroid ─────

  private static cluster(
    validated: Array<{ pos: vec3; type: 'indoor' | 'outdoor' }>,
    sceneName: string,
  ): ProbeCandidate[] {
    const cells = new Map<string, { positions: vec3[]; type: 'indoor' | 'outdoor' }>();

    for (const { pos, type } of validated) {
      const key = `${Math.floor(pos[0] / CELL_SIZE)},${Math.floor(pos[1] / CELL_SIZE)},${Math.floor(pos[2] / CELL_SIZE)}`;
      if (!cells.has(key)) cells.set(key, { positions: [], type });
      cells.get(key)!.positions.push(pos);
    }

    const out: ProbeCandidate[] = [];
    let idx = 0;
    for (const { positions, type } of cells.values()) {
      const centre = vec3.create();
      for (const p of positions) vec3.add(centre, centre, p);
      vec3.scale(centre, centre, 1 / positions.length);

      out.push({
        name: `${sceneName}_Probe_${idx++}`,
        position: [centre[0], centre[1], centre[2]],
        estimatedExtents: [CELL_SIZE / 2, CELL_SIZE / 2, CELL_SIZE / 2],
        type,
      });
    }

    return out;
  }

  // ── Spawn — awaits full entity registration before returning ───────────────

  private static async spawn(probes: ProbeCandidate[]): Promise<void> {
    await Promise.all(
      probes.map(async (p) => {
        const entityJson = {
          prefab: 'lighting/reflection_probe.prefab',
          components: {
            name: p.name,
            transform: { position: p.position },
            reflection_probe: {
              resolution: 512,
              type: p.type,
              extents: p.estimatedExtents,
            },
          },
        };
        const parsed = await Loader.parseEntityFromJSON(entityJson as any);
        await Loader.loadEntityFromJSON(parsed);
      }),
    );
  }

  // ── Serialise placed probes to a scene-compatible JSON array ───────────────

  public static buildSceneJSON(probes: ProbeCandidate[]): object[] {
    return probes.map((p) => ({
      prefab: 'lighting/reflection_probe.prefab',
      components: {
        name: p.name,
        transform: { position: p.position },
        reflection_probe: {
          resolution: 512,
          type: p.type,
          extents: p.estimatedExtents,
        },
      },
    }));
  }
}
