import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { NavMesh } from '../../ai/nav/NavMesh';
import { Loader } from '../../core/loaders/Loader';

export interface ProbeCandidate {
  name: string;
  position: [number, number, number];
  /** Half-extents for PCC AABB (spacing/2 on XZ, FLOOR_HEIGHT/2 on Y). */
  estimatedExtents: [number, number, number];
  /** XZ spacing used when generating this probe — drives the collider size. */
  spacing: number;
  type: 'indoor' | 'outdoor';
}

const DEFAULT_SPACING = 6.0; // metres — default XZ distance between probe centres
const FLOOR_OFFSET  = 1.5;  // metres above detected floor
const FLOOR_HEIGHT  = 3.5;  // metres — vertical scan step (also used as Y collider coverage)
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
const p3 = (v: vec3 | [number,number,number]) => `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;
const DIRS = ['+X', '-X', '+Z', '-Z'];

export class ProbeAutoPlacement {

  /**
   * Places probes, awaits their entity registration, downloads placement JSON.
   *
   * @param sceneName  Scene prefix used in probe names.
   * @param spacing    XZ distance between probe centres in metres (default 6).
   *                   Also determines the collider and PCC AABB size so adjacent
   *                   probes tile perfectly without gaps.
   */
  public static async generate(sceneName: string, spacing = DEFAULT_SPACING): Promise<ProbeCandidate[]> {
    const navMesh = NavMesh.getInstance();
    const strategy = navMesh.isBuilt() ? 'NavMesh' : 'grid';

    console.group(`[ProbeAutoPlacement] generate — strategy: ${strategy}, spacing: ${spacing}m`);

    const seeds = navMesh.isBuilt()
      ? ProbeAutoPlacement.seedsFromNavMesh(navMesh, spacing)
      : ProbeAutoPlacement.seedsFromGrid(spacing);

    if (seeds.length === 0) {
      console.warn('No candidate seeds — check physics/navmesh.');
      console.groupEnd();
      return [];
    }

    console.log(`Seeds after dedup: ${seeds.length}`);

    const validated = ProbeAutoPlacement.validate(seeds);
    console.log(`Validated (passed clearance): ${validated.length} / ${seeds.length}`);

    const candidates = ProbeAutoPlacement.cluster(validated, sceneName, spacing);
    console.log(`Final probes after cluster: ${candidates.length}`);
    candidates.forEach((c) =>
      console.log(`  ✓ ${c.name}  pos=${p3(c.position)}  type=${c.type}`),
    );

    console.groupEnd();

    await ProbeAutoPlacement.spawn(candidates);
    return candidates;
  }

  // ── Strategy 1: NavMesh centroids ──────────────────────────────────────────

  private static seedsFromNavMesh(navMesh: NavMesh, spacing: number): vec3[] {
    const seen = new Set<string>();
    const out: vec3[] = [];
    let skipped = 0;
    for (const c of navMesh.getCentroids()) {
      const key = `${Math.round(c[0] / spacing)},${Math.round(c[2] / spacing)}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      out.push(vec3.fromValues(c[0], c[1] + FLOOR_OFFSET, c[2]));
    }
    console.log(`[NavMesh] centroids=${navMesh.getCentroids().length}, unique cells=${out.length}, skipped=${skipped}`);
    return out;
  }

  // ── Strategy 2: Physics AABB grid ──────────────────────────────────────────

  private static seedsFromGrid(spacing: number): vec3[] {
    const physics = Engine.getPhysics();
    const { min, max } = physics.getSceneAABB();

    console.log(`[Grid] AABB min=${p3(min)} max=${p3(max)}`);
    console.group('[Grid] Raycast results per cell');

    const seen = new Set<string>();
    const out: vec3[] = [];
    let cellsMiss = 0, cellsInside = 0, cellsDup = 0;

    for (let x = min[0] + spacing / 2; x < max[0]; x += spacing) {
      for (let z = min[2] + spacing / 2; z < max[2]; z += spacing) {
        let foundInColumn = false;
        for (let y = max[1] + 1; y >= min[1]; y -= FLOOR_HEIGHT) {
          const origin = vec3.fromValues(x, y, z);
          const hit = physics.raycast(origin, DIR_DOWN, FLOOR_HEIGHT + 0.5, true);

          if (!hit) {
            console.log(`  (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ↓ no hit within ${(FLOOR_HEIGHT+0.5).toFixed(1)}m`);
            cellsMiss++;
            continue;
          }

          const floorY = y - hit.timeOfImpact;

          if (hit.timeOfImpact < 0.05) {
            console.log(`  (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ↓ hit at t=${hit.timeOfImpact.toFixed(3)} → INSIDE SOLID, skip`);
            cellsInside++;
            continue;
          }

          const candidate = vec3.fromValues(x, floorY + FLOOR_OFFSET, z);
          const yBand = Math.round(floorY / FLOOR_HEIGHT);
          const key = `${Math.round(x / spacing)},${yBand},${Math.round(z / spacing)}`;

          if (seen.has(key)) {
            console.log(`  (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ↓ hit floor@${floorY.toFixed(2)} → DUPLICATE cell, skip`);
            cellsDup++;
            continue;
          }

          seen.add(key);
          out.push(candidate);
          foundInColumn = true;
          console.log(`  (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ↓ hit t=${hit.timeOfImpact.toFixed(2)} → floor@${floorY.toFixed(2)}, probe@${(floorY+FLOOR_OFFSET).toFixed(2)} ✓`);
        }
        if (!foundInColumn) {
          console.log(`  column (${x.toFixed(1)}, ${z.toFixed(1)}) → no probe placed`);
        }
      }
    }

    console.groupEnd();
    console.log(`[Grid] seeds=${out.length}  miss=${cellsMiss}  inside=${cellsInside}  dup=${cellsDup}`);
    return out;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  private static validate(seeds: vec3[]): Array<{ pos: vec3; type: 'indoor' | 'outdoor' }> {
    const physics = Engine.getPhysics();
    const out: Array<{ pos: vec3; type: 'indoor' | 'outdoor' }> = [];

    console.group('[Validate] clearance + ceiling check per seed');

    for (const pos of seeds) {
      let blockedDir: string | null = null;
      let blockedDist = 0;
      for (let i = 0; i < CARDINALS.length; i++) {
        const hit = physics.raycast(pos, CARDINALS[i]!, MIN_CLEARANCE, false);
        if (hit !== null) {
          blockedDir = DIRS[i]!;
          blockedDist = hit.timeOfImpact;
          break;
        }
      }

      if (blockedDir !== null) {
        console.log(`  ${p3(pos)} → REJECTED: wall ${blockedDir} at ${blockedDist.toFixed(2)}m (min ${MIN_CLEARANCE}m)`);
        continue;
      }

      const ceilHit = physics.raycast(pos, DIR_UP, CEIL_MAX, false);
      const type = ceilHit ? 'indoor' : 'outdoor';
      const ceilDesc = ceilHit ? `ceil@${ceilHit.timeOfImpact.toFixed(2)}m` : `no ceil within ${CEIL_MAX}m`;
      console.log(`  ${p3(pos)} → OK  ${ceilDesc}  type=${type}`);
      out.push({ pos, type });
    }

    console.groupEnd();
    return out;
  }

  // ── Cluster into spacing³ cells — one probe per cell at the centroid ────────

  private static cluster(
    validated: Array<{ pos: vec3; type: 'indoor' | 'outdoor' }>,
    sceneName: string,
    spacing: number,
  ): ProbeCandidate[] {
    const cells = new Map<string, { positions: vec3[]; type: 'indoor' | 'outdoor' }>();

    for (const { pos, type } of validated) {
      const key = `${Math.floor(pos[0] / spacing)},${Math.floor(pos[1] / spacing)},${Math.floor(pos[2] / spacing)}`;
      if (!cells.has(key)) cells.set(key, { positions: [], type });
      cells.get(key)!.positions.push(pos);
    }

    const out: ProbeCandidate[] = [];
    let idx = 0;
    for (const { positions, type } of cells.values()) {
      const centre = vec3.create();
      for (const p of positions) vec3.add(centre, centre, p);
      vec3.scale(centre, centre, 1 / positions.length);

      // Half-extents for PCC AABB: tiles exactly with adjacent probes.
      // Box collider uses full dimensions (spacing × FLOOR_HEIGHT × spacing).
      out.push({
        name: `${sceneName}_Probe_${idx++}`,
        position: [centre[0], centre[1], centre[2]],
        estimatedExtents: [spacing / 2, FLOOR_HEIGHT / 2, spacing / 2],
        spacing,
        type,
      });
    }

    return out;
  }

  // ── Spawn — awaits full entity registration before returning ───────────────

  private static async spawn(probes: ProbeCandidate[]): Promise<void> {
    await Promise.all(
      probes.map(async (p) => {
        const parsed = await Loader.parseEntityFromJSON(ProbeAutoPlacement.buildEntityJSON(p) as any);
        await Loader.loadEntityFromJSON(parsed);
      }),
    );
  }

  // ── Serialise placed probes to a scene-compatible JSON array ───────────────

  public static buildSceneJSON(probes: ProbeCandidate[]): object[] {
    return probes.map((p) => ProbeAutoPlacement.buildEntityJSON(p));
  }

  private static buildEntityJSON(p: ProbeCandidate): object {
    // box_collider.size is full dimensions — tiles adjacent probes without gaps.
    const colliderSize: [number, number, number] = [p.spacing, FLOOR_HEIGHT, p.spacing];
    return {
      prefab: 'lighting/reflection_probe.prefab',
      components: {
        name: p.name,
        transform: { position: p.position },
        reflection_probe: {
          resolution: 512,
          type: p.type,
          extents: p.estimatedExtents, // half-extents for PCC AABB
        },
        box_collider: {
          isSensor: true,
          bodyType: 'static',
          size: colliderSize,
        },
      },
    };
  }
}
