import { vec3 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { TransformComponent } from '../../../components/core/TransformComponent';
import type { ReflectionProbeComponent } from '../../../components/render/ReflectionProbeComponent';

export interface BlendedProbes {
  /** Primary probe (highest weight). null when no probes are loaded. */
  probeA: ReflectionProbeComponent | null;
  /** Secondary probe. null when the player overlaps only one probe volume. */
  probeB: ReflectionProbeComponent | null;
  /**
   * Blend factor [0, 1] — 0.0 = 100% probeA, 1.0 = 100% probeB.
   * When probeB is null this is always 0.
   */
  blendWeight: number;
}

/**
 * ProbeManager — singleton that tracks all active ReflectionProbeComponents
 * and computes the two dominant probes + blend weight for the player's position.
 *
 * Used by AmbientLight every frame to provide soft irradiance transitions
 * when the player moves between probe volumes.
 */
export class ProbeManager {
  private static _instance: ProbeManager | null = null;
  private _probes: ReflectionProbeComponent[] = [];

  private constructor() {}

  public static getInstance(): ProbeManager {
    if (!ProbeManager._instance) ProbeManager._instance = new ProbeManager();
    return ProbeManager._instance;
  }

  public register(probe: ReflectionProbeComponent): void {
    if (!this._probes.includes(probe)) this._probes.push(probe);
  }

  public unregister(probe: ReflectionProbeComponent): void {
    const idx = this._probes.indexOf(probe);
    if (idx !== -1) this._probes.splice(idx, 1);
  }

  /**
   * Returns the two probes with the highest box-intersection weights for the
   * current player position, plus the blend factor between them.
   *
   * Weight = how "inside" the probe box the player is (0 = outside, 1 = centre).
   * Only probes whose box volume contains the player contribute.
   */
  public getBlendedProbes(): BlendedProbes {
    if (this._probes.length === 0) {
      return { probeA: null, probeB: null, blendWeight: 0 };
    }

    const playerPos = this._getPlayerPosition();
    if (!playerPos) return { probeA: null, probeB: null, blendWeight: 0 };

    // Compute weight for every probe
    const weighted = this._probes
      .map((probe) => ({ probe, weight: this._boxWeight(probe, playerPos) }))
      .filter((p) => p.weight > 0)
      .sort((a, b) => b.weight - a.weight);

    if (weighted.length === 0) return { probeA: null, probeB: null, blendWeight: 0 };

    const probeA = weighted[0]!.probe;
    const probeB = weighted[1]?.probe ?? null;

    // blendWeight = how much of probeB we see relative to probeA
    const blendWeight =
      probeB && weighted[0]!.weight > 0
        ? Math.min(1, weighted[1]!.weight / weighted[0]!.weight)
        : 0;

    return { probeA, probeB, blendWeight };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Returns a [0,1] weight representing how deep inside the probe's box
   * volume the player is. 0 = outside or at the edge, 1 = at the centre.
   */
  private _boxWeight(probe: ReflectionProbeComponent, pos: vec3): number {
    const probePos = probe.getPosition();
    const extents = probe.getExtents();

    const fx = 1.0 - Math.abs(pos[0] - probePos[0]) / extents[0];
    const fy = 1.0 - Math.abs(pos[1] - probePos[1]) / extents[1];
    const fz = 1.0 - Math.abs(pos[2] - probePos[2]) / extents[2];

    if (fx <= 0 || fy <= 0 || fz <= 0) return 0; // outside the box
    return Math.min(fx, fy, fz);
  }

  private _getPlayerPosition(): vec3 | null {
    const player = Engine.getEntities().getEntityByName('Player');
    if (!player) return null;
    const tc = player.getComponent('transform') as TransformComponent | null;
    return tc?.getTransform().getWorldPosition() ?? null;
  }
}
