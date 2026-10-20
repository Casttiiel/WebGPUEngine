import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { Loader } from '../../core/loaders/Loader';

export interface ProbeCandidate {
  name: string;
  /** Capture point. */
  position: [number, number, number];
  /** Influence box centre relative to the capture point (the box stays on the grid). */
  boxOffset: [number, number, number];
  /** Influence box half extents: spacing/2 on XZ — boxes tile. */
  estimatedExtents: [number, number, number];
  /** Cross-fade per axis: wide between cells, short vertically (floor fully inside). */
  fade: [number, number, number];
  type: 'indoor' | 'outdoor';
}

const DEFAULT_SPACING = 8.0; // metres between probe centres (XZ)
const CAPTURE_HEIGHT = 1.5; // capture point above the floor
const BOX_BELOW = 1.0; // influence box: from this far under the floor…
const BOX_ABOVE = 4.0; // …to this far above it
const LEVEL_STEP = 3.5; // vertical scan step for stacked floors
const CEIL_MAX = 20.0; // upward ray that classifies indoor / outdoor
const MIN_CLEARANCE = 0.6; // capture point distance to walls

const DIR_DOWN = vec3.fromValues(0, -1, 0);
const DIR_UP = vec3.fromValues(0, 1, 0);
const CARDINALS = [
  vec3.fromValues(1, 0, 0),
  vec3.fromValues(-1, 0, 0),
  vec3.fromValues(0, 0, 1),
  vec3.fromValues(0, 0, -1),
];

/**
 * ProbeAutoPlacement — F7. One probe per grid cell and floor level:
 *   • the influence box is the cell (spacing on XZ, BOX_BELOW…BOX_ABOVE around the floor), so neighbouring
 *     boxes tile and cross-fade at their shared faces (no gaps, no seams)
 *   • the capture point starts at the cell centre, CAPTURE_HEIGHT over the floor, and moves
 *     inside the cell when that spot is in or against geometry (a capture inside a crate
 *     would see only black)
 */
export class ProbeAutoPlacement {
  public static async generate(sceneName: string, spacing = DEFAULT_SPACING): Promise<ProbeCandidate[]> {
    const physics = Engine.getPhysics();
    const { min, max } = physics.getSceneAABB();
    const out: ProbeCandidate[] = [];
    let rejected = 0;

    for (let x = min[0] + spacing / 2; x < max[0]; x += spacing) {
      for (let z = min[2] + spacing / 2; z < max[2]; z += spacing) {
        for (const floorY of ProbeAutoPlacement.floorsAt(x, z, min[1], max[1], spacing)) {
          const capture = ProbeAutoPlacement.findCapturePoint(x, floorY + CAPTURE_HEIGHT, z, spacing);
          if (!capture) {
            rejected++;
            continue;
          }
          const boxCentre = [x, floorY + (BOX_ABOVE - BOX_BELOW) / 2, z];
          const ceil = physics.raycast(capture, DIR_UP, CEIL_MAX, false);
          out.push({
            name: `${sceneName}_Probe_${out.length}`,
            position: [capture[0], capture[1], capture[2]],
            boxOffset: [boxCentre[0]! - capture[0], boxCentre[1]! - capture[1], boxCentre[2]! - capture[2]],
            estimatedExtents: [spacing / 2, (BOX_ABOVE + BOX_BELOW) / 2, spacing / 2],
            fade: [spacing / 4, 0.5, spacing / 4],
            type: ceil ? 'indoor' : 'outdoor',
          });
        }
      }
    }
    console.log(`[ProbeAutoPlacement] ${out.length} probes (spacing ${spacing} m, ${rejected} cells fully blocked)`);
    await ProbeAutoPlacement.spawn(out);
    return out;
  }

  /**
   * Floor levels of the cell: rays down at a few spots (one centred on a column would never
   * reach the ground), merged so floors closer than half a level count once — keeping the
   * lowest, or a crate top would replace the ground under it.
   */
  private static floorsAt(x: number, z: number, minY: number, maxY: number, spacing: number): number[] {
    const physics = Engine.getPhysics();
    const r = spacing * 0.35;
    const hits: number[] = [];
    for (const [dx, dz] of [[0, 0], [r, r], [-r, r], [r, -r], [-r, -r]] as const) {
      for (let y = maxY + 1; y >= minY; y -= LEVEL_STEP) {
        const hit = physics.raycast(vec3.fromValues(x + dx, y, z + dz), DIR_DOWN, LEVEL_STEP + 0.5, true);
        if (hit && hit.timeOfImpact >= 0.05) hits.push(y - hit.timeOfImpact); // not from inside a solid
      }
    }
    hits.sort((a, b) => a - b);
    const floors: number[] = [];
    for (const f of hits) {
      if (floors.length === 0 || f - floors[floors.length - 1]! >= LEVEL_STEP * 0.5) floors.push(f);
    }
    return floors;
  }

  /** Cell centre if it's clear, else the first clear spot of a few inside the cell. */
  private static findCapturePoint(x: number, y: number, z: number, spacing: number): vec3 | null {
    const r = spacing * 0.35;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [r / 2, 0], [-r / 2, 0], [0, r / 2], [0, -r / 2],
      [r / 2, r / 2], [-r / 2, r / 2], [r / 2, -r / 2], [-r / 2, -r / 2],
      [r, 0], [-r, 0], [0, r], [0, -r],
    ];
    for (const [dx, dz] of offsets) {
      const p = vec3.fromValues(x + dx, y, z + dz);
      if (ProbeAutoPlacement.isClear(p)) return p;
    }
    return null;
  }

  /** Not inside geometry (the floor under it is the first thing hit from above) and away from walls. */
  private static isClear(p: vec3): boolean {
    const physics = Engine.getPhysics();
    const roof = physics.raycast(p, DIR_UP, CEIL_MAX, false);
    const from = roof ? roof.timeOfImpact - 0.05 : CEIL_MAX;
    const above = vec3.fromValues(p[0], p[1] + from, p[2]);
    const down = physics.raycast(above, DIR_DOWN, from + CAPTURE_HEIGHT + 0.5, true);
    // Something between the roof (or the sky) and the floor: the point is inside it.
    if (down && down.timeOfImpact < from - 0.05) return false;
    return CARDINALS.every((d) => physics.raycast(p, d, MIN_CLEARANCE, false) === null);
  }

  private static async spawn(probes: ProbeCandidate[]): Promise<void> {
    await Promise.all(
      probes.map(async (p) => {
        const parsed = await Loader.parseEntityFromJSON(ProbeAutoPlacement.buildEntityJSON(p) as any);
        await Loader.loadEntityFromJSON(parsed);
      }),
    );
  }

  /** Scene-compatible JSON array (saved as assets/scenes/{scene}_probes.json). */
  public static buildSceneJSON(probes: ProbeCandidate[]): object[] {
    return probes.map((p) => ProbeAutoPlacement.buildEntityJSON(p));
  }

  private static buildEntityJSON(p: ProbeCandidate): object {
    const round = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000);
    return {
      prefab: 'lighting/reflection_probe.prefab',
      components: {
        name: p.name,
        transform: { position: round(p.position) },
        reflection_probe: {
          resolution: 128,
          type: p.type,
          extents: round(p.estimatedExtents),
          boxOffset: round(p.boxOffset),
          fade: round(p.fade),
        },
      },
    };
  }
}
