import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { PointLightComponent } from '../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../components/render/SpotLightComponent';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory } from '../core/factories/PipelineFactory';
import { GPUUtils } from '../core/utils/GPUUtils';

/** Must match gi/common/gi_light_grid.wgsl and gi/gi_light_grid.cs. */
const GRID_DIM = 16;
const GRID_CASCADES = 4;
const CELL_STRIDE = 32;
/** Cell size of the finest cascade (m); each cascade doubles it. */
const BASE_CELL = 1.0;
/** Lights uploaded (nearest the camera first); cells keep the first 31 that touch them. */
export const GI_MAX_LIGHTS = 256;
/** GILight in gi/common/gi_common.wgsl. */
const LIGHT_FLOATS = 12;
/**
 * A light may drift this far (flicker jitter, slow movers) before the grid is rebuilt; the
 * build inflates every sphere by it (gi_light_grid.cs SLACK) so the cells still cover it.
 */
const MOVE_SLACK = 0.1;
/** Frames between rebuilds that re-sort the lights by distance to the camera. */
const RESORT_INTERVAL = 30;

type GILightComponent = PointLightComponent | SpotLightComponent;

/**
 * World-space light grid for the GI (docs/realtime-gi-plan.md, phase 3b): every point/spot
 * light goes to the GPU (nearest the camera first), and a compute pass lists, per cell of
 * GRID_CASCADES camera-centred cascades of GRID_DIM³ cells, the lights whose sphere touches it.
 * Hit shading (gi/common/gi_light_grid.wgsl) then weighs only the lights of its cell, so the
 * cost no longer depends on how many lights the scene has.
 *
 * The cell lists only depend on where the lights are, so the grid is rebuilt only when the
 * light set changes, a light moves past MOVE_SLACK, a cascade scrolls, or every
 * RESORT_INTERVAL frames (fresh distance order). Between rebuilds the light order is frozen and
 * only colour/intensity are re-uploaded each frame (flicker).
 */
export class GIWorldLightGrid {
  public readonly lightsBuffer: GPUBuffer;
  public readonly gridBuffer: GPUBuffer;
  /** Per cascade: world min corner xyz, cell size (GIParams.lightGrid). */
  public readonly origins = new Float32Array(GRID_CASCADES * 4);

  private lightsData = new Float32Array(GI_MAX_LIGHTS * LIGHT_FLOATS);
  /** Lights in GPU order, frozen between rebuilds; position + radius at the last rebuild. */
  private ordered: GILightComponent[] = [];
  private builtSpheres = new Float32Array(GI_MAX_LIGHTS * 4);
  private framesSinceBuild = 0;
  private dirty = true;

  private found: GILightComponent[] = [];
  private foundSet = new Set<GILightComponent>();
  private sortDist = new Map<GILightComponent, number>();
  private byDistance = (a: GILightComponent, b: GILightComponent) =>
    this.sortDist.get(a)! - this.sortDist.get(b)!;
  private scratch = vec3.create();

  private pipeline: GPUComputePipeline | null = null;
  private layout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupParams: GPUBuffer | null = null;

  constructor() {
    this.lightsBuffer = GPUUtils.createBuffer(
      'gi_lights',
      this.lightsData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.gridBuffer = GPUUtils.createBuffer(
      'gi_light_grid',
      GRID_CASCADES * GRID_DIM ** 3 * CELL_STRIDE * 4,
      GPUBufferUsage.STORAGE,
    );
    const C = GPUShaderStage.COMPUTE;
    this.layout = BindGroupFactory.getLayout('gi_light_grid_layout', [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'storage' } },
    ]);
  }

  public async load(): Promise<void> {
    const code = await ResourceManager.loadShader('gi/gi_light_grid.cs');
    this.pipeline = await GPUUtils.getDevice().createComputePipelineAsync({
      label: 'gi_light_grid',
      layout: PipelineFactory.createPipelineLayout('gi_light_grid_pl', [this.layout]),
      compute: {
        module: GPUUtils.getDevice().createShaderModule({ label: 'gi_light_grid', code }),
        entryPoint: 'cs',
      },
    });
  }

  public getLightCount(): number {
    return this.ordered.length;
  }

  private static positionOf(l: GILightComponent): vec3 {
    return l instanceof SpotLightComponent ? l.getCamera().getPosition() : l.getWorldPosition();
  }

  /** Uploads the lights and decides whether the cell lists need rebuilding this frame. */
  public prepare(cameraPos: vec3): void {
    const found = this.found;
    const foundSet = this.foundSet;
    found.length = 0;
    foundSet.clear();
    const entities = Engine.getEntities();
    for (const comp of entities.getObjectManagerByName('point_light')?.getList() ?? []) {
      const pl = comp as PointLightComponent;
      if (pl.getIntensity() > 0) found.push(pl);
    }
    for (const comp of entities.getObjectManagerByName('spot_light')?.getList() ?? []) {
      const sl = comp as SpotLightComponent;
      if (sl.getIntensity() > 0) found.push(sl);
    }
    for (const l of found) foundSet.add(l);

    // Cascades snapped to their own cell size: they only scroll by whole cells.
    let scrolled = false;
    for (let c = 0; c < GRID_CASCADES; c++) {
      const cell = BASE_CELL * 2 ** c;
      for (let k = 0; k < 3; k++) {
        const o = (Math.floor(cameraPos[k]! / cell) - GRID_DIM / 2) * cell;
        if (this.origins[c * 4 + k] !== o) scrolled = true;
        this.origins[c * 4 + k] = o;
      }
      this.origins[c * 4 + 3] = cell;
    }

    const expected = Math.min(found.length, GI_MAX_LIGHTS);
    let rebuild =
      this.dirty ||
      scrolled ||
      ++this.framesSinceBuild >= RESORT_INTERVAL ||
      this.ordered.length !== expected ||
      this.ordered.some((l) => !foundSet.has(l));
    for (let i = 0; i < this.ordered.length && !rebuild; i++) {
      const l = this.ordered[i]!;
      const b = this.builtSpheres;
      const moved = vec3.distance(
        GIWorldLightGrid.positionOf(l),
        vec3.set(this.scratch, b[i * 4]!, b[i * 4 + 1]!, b[i * 4 + 2]!),
      );
      if (moved > MOVE_SLACK || l.getRadius() !== b[i * 4 + 3]) rebuild = true;
    }

    if (rebuild) {
      this.sortDist.clear();
      for (const l of found) {
        this.sortDist.set(
          l,
          vec3.distance(GIWorldLightGrid.positionOf(l), cameraPos) - l.getRadius(),
        );
      }
      found.sort(this.byDistance);
      this.ordered = found.slice(0, GI_MAX_LIGHTS);
      this.ordered.forEach((l, i) => {
        const p = GIWorldLightGrid.positionOf(l);
        this.builtSpheres.set([p[0]!, p[1]!, p[2]!, l.getRadius()], i * 4);
      });
      this.framesSinceBuild = 0;
      this.dirty = true;
    }

    const data = this.lightsData;
    for (let i = 0; i < this.ordered.length; i++) {
      const l = this.ordered[i]!;
      const o = i * LIGHT_FLOATS;
      const col = l.getColor();
      const k = l.getIntensity();
      const pos = GIWorldLightGrid.positionOf(l);
      data[o] = pos[0]!;
      data[o + 1] = pos[1]!;
      data[o + 2] = pos[2]!;
      data[o + 3] = l.getRadius();
      data[o + 4] = col[0]! * k;
      data[o + 5] = col[1]! * k;
      data[o + 6] = col[2]! * k;
      data[o + 7] = l.getStartFalloff();
      if (l instanceof SpotLightComponent) {
        const dir = l.getCamera().getFront();
        data[o + 8] = dir[0]!;
        data[o + 9] = dir[1]!;
        data[o + 10] = dir[2]!;
        data[o + 11] = Math.cos(l.getCamera().getFov() * 0.5);
      } else {
        data[o + 8] = data[o + 9] = data[o + 10] = 0;
        data[o + 11] = -2; // point light
      }
    }
    if (this.ordered.length > 0) {
      GPUUtils.writeBuffer(
        this.lightsBuffer,
        0,
        data.subarray(0, this.ordered.length * LIGHT_FLOATS),
      );
    }
  }

  /** Rebuilds the cell lists when prepare() found them stale (params hold this frame's origins). */
  public dispatch(
    paramsBuffer: GPUBuffer,
    run: (label: string, fn: (pass: GPUComputePassEncoder) => void) => void,
  ): void {
    if (!this.pipeline || !this.dirty) return;
    if (!this.bindGroup || this.bindGroupParams !== paramsBuffer) {
      this.bindGroupParams = paramsBuffer;
      this.bindGroup = BindGroupFactory.createBindGroup('gi_light_grid_bg', this.layout, [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: this.lightsBuffer } },
        { binding: 2, resource: { buffer: this.gridBuffer } },
      ]);
    }
    run('GI Light Grid', (pass) => {
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.bindGroup!);
      pass.dispatchWorkgroups(Math.ceil((GRID_CASCADES * GRID_DIM ** 3) / 64));
    });
    this.dirty = false;
  }

  public destroy(): void {
    this.lightsBuffer.destroy();
    this.gridBuffer.destroy();
    this.bindGroup = null;
  }
}
