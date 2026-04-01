import { Engine } from '../../../core/engine/Engine';
import { ResourceManager } from '../../../core/engine/ResourceManager';
import { GPUUtils } from '../utils/GPUUtils';
import { GPUProfiler } from '../../../core/debug/GPUProfiler';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory } from '../factories/PipelineFactory';
import { PointLightComponent } from '../../../components/render/PointLightComponent';
import { SpotLightComponent } from '../../../components/render/SpotLightComponent';
import { CameraComponent } from '../../../components/render/CameraComponent';

/**
 * Manages the tile-based light culling system.
 *
 * Phase 1 – Shared GPU light buffers: single PointLightEntry[] and SpotLightEntry[] arrays
 *           populated each frame from the visible shadowless lights.
 * Phase 2 – Compute cull pass: 16×16-thread workgroups, one per screen tile, build per-tile light lists.
 * Phase 3 – Full-screen tiled lighting fragment pass replaces per-light sphere/frustum draw calls.
 *
 * Shadow lights are NOT handled here — they continue using the geometry-volume approach.
 *
 * IMPORTANT: MAX_LIGHTS_PER_TILE and TILE_SIZE must match the WGSL constants in
 * tiled_light_culling.cs and tiled_lighting.fs.
 */
export class TiledLightManager {
  // ─── Constants (must match WGSL) ───────────────────────────────────────
  public static readonly MAX_POINT_LIGHTS = 1024;
  public static readonly MAX_SPOT_LIGHTS = 256;
  /** Max lights stored per tile in the GPU tile list buffers. */
  public static readonly MAX_LIGHTS_PER_TILE = 64;
  public static readonly TILE_SIZE = 16;

  // Struct sizes in floats (PointLightEntry = 3×vec4, SpotLightEntry = 4×vec4)
  private static readonly POINT_FLOATS = 12;
  private static readonly SPOT_FLOATS = 16;

  // ─── Fixed-size GPU buffers (created in load, destroyed in dispose) ───
  private paramsBuffer!: GPUBuffer; // TiledCullingParams  (16 bytes = 4×u32)
  private pointLightBuffer!: GPUBuffer; // PointLightEntry[]   (MAX × 48 bytes)
  private spotLightBuffer!: GPUBuffer; // SpotLightEntry[]    (MAX × 64 bytes)

  // ─── Resize-dependent GPU buffers (recreated on each resize) ──────────
  private tileLightCountBuffer!: GPUBuffer; // vec2<u32>[] per tile
  private tilePointListBuffer!: GPUBuffer; // u32[]  (numTiles × MAX_LIGHTS_PER_TILE)
  private tileSpotListBuffer!: GPUBuffer; // u32[]  (numTiles × MAX_LIGHTS_PER_TILE)

  // ─── CPU staging ───────────────────────────────────────────────────────
  private pointLightData!: Float32Array;
  private spotLightData!: Float32Array;
  private paramsData = new Uint32Array(4);

  // ─── Tile dimensions ───────────────────────────────────────────────────
  private numTilesX = 0;
  private numTilesY = 0;

  // ─── Bind groups (invalidated on resize) ──────────────────────────────
  private computeDataBindGroup: GPUBindGroup | null = null;
  private renderDataBindGroup: GPUBindGroup | null = null;
  private cameraComputeBindGroup: GPUBindGroup | null = null;
  private lastCameraBuffer: GPUBuffer | null = null;

  // ─── Pipeline ─────────────────────────────────────────────────────────
  private cullingPipeline!: GPUComputePipeline;
  private isLoaded = false;

  // ─────────────────────────────────────────────────────────────────────

  public async load(): Promise<void> {
    const MAX_P = TiledLightManager.MAX_POINT_LIGHTS;
    const MAX_S = TiledLightManager.MAX_SPOT_LIGHTS;
    const PF = TiledLightManager.POINT_FLOATS;
    const SF = TiledLightManager.SPOT_FLOATS;

    this.paramsBuffer = GPUUtils.createBuffer(
      'tiled_params',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.pointLightBuffer = GPUUtils.createBuffer(
      'tiled_point_lights',
      MAX_P * PF * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.spotLightBuffer = GPUUtils.createBuffer(
      'tiled_spot_lights',
      MAX_S * SF * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );

    this.pointLightData = new Float32Array(MAX_P * PF);
    this.spotLightData = new Float32Array(MAX_S * SF);

    // Compile compute pipeline
    const code = await ResourceManager.loadShader('lighting/tiled_light_culling.cs');
    const device = GPUUtils.getDevice();
    const module = device.createShaderModule({ label: 'Tiled Light Culling', code });

    const pipelineLayout = PipelineFactory.createPipelineLayout('tiled_cull_pipeline_layout', [
      BindGroupFactory.getCameraComputeLayout(),
      BindGroupFactory.getTiledLightComputeCullingLayout(),
    ]);

    this.cullingPipeline = PipelineFactory.createComputePipeline({
      label: 'Tiled Light Culling Pipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'cs_tileLight' },
    });

    this.isLoaded = true;
  }

  /**
   * Recreates the tile-sized buffers for the new render resolution.
   * Must be called after every resize before the next frame.
   */
  public resize(width: number, height: number): void {
    const TS = TiledLightManager.TILE_SIZE;
    const MAX_L = TiledLightManager.MAX_LIGHTS_PER_TILE;

    this.numTilesX = Math.ceil(width / TS);
    this.numTilesY = Math.ceil(height / TS);
    const numTiles = this.numTilesX * this.numTilesY;

    this.tileLightCountBuffer?.destroy();
    this.tilePointListBuffer?.destroy();
    this.tileSpotListBuffer?.destroy();

    this.tileLightCountBuffer = GPUUtils.createBuffer(
      'tile_light_counts',
      numTiles * 8, // vec2<u32> = 8 bytes
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.tilePointListBuffer = GPUUtils.createBuffer(
      'tile_point_lists',
      numTiles * MAX_L * 4, // u32 array
      GPUBufferUsage.STORAGE,
    );
    this.tileSpotListBuffer = GPUUtils.createBuffer(
      'tile_spot_lists',
      numTiles * MAX_L * 4,
      GPUBufferUsage.STORAGE,
    );

    // Invalidate bind groups — they reference the destroyed buffers
    this.computeDataBindGroup = null;
    this.renderDataBindGroup = null;
  }

  /**
   * Collects visible shadowless lights from ECS and uploads them to the GPU batch buffers.
   * Call once per frame, just before dispatchCulling().
   */
  public prepare(): void {
    if (!this.isLoaded || this.numTilesX === 0) return;

    let pointCount = 0;
    let spotCount = 0;
    const PF = TiledLightManager.POINT_FLOATS;
    const SF = TiledLightManager.SPOT_FLOATS;

    // ── Point lights (shadowless + visible) ──────────────────────────────
    for (const comp of Engine.getEntities().getObjectManagerByName('point_light')?.getList() ??
      []) {
      const pl = comp as PointLightComponent;
      if (pl.hasShadows() || !pl.isVisible()) continue;
      if (pointCount >= TiledLightManager.MAX_POINT_LIGHTS) break;

      const o = pointCount * PF;
      const pos = pl.getWorldPosition();
      const col = pl.getColor();

      this.pointLightData[o + 0] = col[0];
      this.pointLightData[o + 1] = col[1];
      this.pointLightData[o + 2] = col[2];
      this.pointLightData[o + 3] = pl.getIntensity(); // w = intensity
      this.pointLightData[o + 4] = pos[0];
      this.pointLightData[o + 5] = pos[1];
      this.pointLightData[o + 6] = pos[2];
      this.pointLightData[o + 7] = pl.getRadius(); // w = outerRadius
      this.pointLightData[o + 8] = pl.getStartFalloff(); // x = startFalloff
      // o+9 .. o+11 = pad (0 by default in Float32Array)
      pointCount++;
    }

    // ── Spot lights (shadowless + visible) ───────────────────────────────
    for (const comp of Engine.getEntities().getObjectManagerByName('spot_light')?.getList() ?? []) {
      const sl = comp as SpotLightComponent;
      if (sl.hasShadows() || !sl.isVisible()) continue;
      if (spotCount >= TiledLightManager.MAX_SPOT_LIGHTS) break;

      const o = spotCount * SF;
      const cam = sl.getCamera();
      const pos = cam.getPosition();
      const dir = cam.getFront();
      // getFov() returns radians; half-angle for cone test
      const cosHalf = Math.cos(cam.getFov() * 0.5);
      const col = sl.getColor();

      this.spotLightData[o + 0] = col[0];
      this.spotLightData[o + 1] = col[1];
      this.spotLightData[o + 2] = col[2];
      this.spotLightData[o + 3] = sl.getIntensity(); // w = intensity
      this.spotLightData[o + 4] = pos[0];
      this.spotLightData[o + 5] = pos[1];
      this.spotLightData[o + 6] = pos[2];
      this.spotLightData[o + 7] = sl.getRadius(); // w = outerRadius
      this.spotLightData[o + 8] = sl.getStartFalloff(); // x = startFalloff
      // o+9..11 = pad
      this.spotLightData[o + 12] = dir[0];
      this.spotLightData[o + 13] = dir[1];
      this.spotLightData[o + 14] = dir[2];
      this.spotLightData[o + 15] = cosHalf; // w = cos(halfAngle)
      spotCount++;
    }

    // ── GPU upload ───────────────────────────────────────────────────────
    if (pointCount > 0) {
      GPUUtils.writeBuffer(
        this.pointLightBuffer,
        0,
        this.pointLightData.subarray(0, pointCount * PF),
      );
    }
    if (spotCount > 0) {
      GPUUtils.writeBuffer(this.spotLightBuffer, 0, this.spotLightData.subarray(0, spotCount * SF));
    }

    this.paramsData[0] = pointCount;
    this.paramsData[1] = spotCount;
    this.paramsData[2] = this.numTilesX;
    this.paramsData[3] = this.numTilesY;
    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  /**
   * Dispatches the tile-culling compute pass.
   * Must be called after prepare() and before the tiled lighting render pass.
   */
  public dispatchCulling(encoder: GPUCommandEncoder): void {
    if (!this.isLoaded || this.numTilesX === 0) return;

    // Camera compute bind group (lazily created / refreshed when camera buffer changes)
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComp = mainCamera?.getComponent('camera') as CameraComponent | undefined;
    if (!cameraComp) return;

    const cameraBuffer = cameraComp.getCamera().getUniformBuffer();
    if (!this.cameraComputeBindGroup || cameraBuffer !== this.lastCameraBuffer) {
      this.lastCameraBuffer = cameraBuffer;
      this.cameraComputeBindGroup = BindGroupFactory.createBindGroup(
        'tiled_camera_compute_bg',
        BindGroupFactory.getCameraComputeLayout(),
        [{ binding: 0, resource: { buffer: cameraBuffer } }],
      );
    }

    // Tiled-data compute bind group (lazily created / recreated after resize)
    if (!this.computeDataBindGroup) {
      this.computeDataBindGroup = BindGroupFactory.createBindGroup(
        'tiled_compute_data_bg',
        BindGroupFactory.getTiledLightComputeCullingLayout(),
        [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.pointLightBuffer } },
          { binding: 2, resource: { buffer: this.spotLightBuffer } },
          { binding: 3, resource: { buffer: this.tileLightCountBuffer } },
          { binding: 4, resource: { buffer: this.tilePointListBuffer } },
          { binding: 5, resource: { buffer: this.tileSpotListBuffer } },
        ],
      );
    }

    const ts = GPUProfiler.getInstance().getTimestampWrites('Tiled Light Cull');
    const computePass = encoder.beginComputePass({
      label: 'Tiled Light Culling',
      ...(ts ? { timestampWrites: ts } : {}),
    });
    computePass.setPipeline(this.cullingPipeline);
    computePass.setBindGroup(0, this.cameraComputeBindGroup);
    computePass.setBindGroup(1, this.computeDataBindGroup);
    computePass.dispatchWorkgroups(this.numTilesX, this.numTilesY, 1);
    computePass.end();
  }

  /**
   * Returns the bind group for the tiled lighting fragment pass (group 2).
   * The same underlying buffers are used; only the visibility flags differ.
   */
  public getRenderDataBindGroup(): GPUBindGroup {
    if (!this.renderDataBindGroup) {
      this.renderDataBindGroup = BindGroupFactory.createBindGroup(
        'tiled_render_data_bg',
        BindGroupFactory.getTiledLightRenderLayout(),
        [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.pointLightBuffer } },
          { binding: 2, resource: { buffer: this.spotLightBuffer } },
          { binding: 3, resource: { buffer: this.tileLightCountBuffer } },
          { binding: 4, resource: { buffer: this.tilePointListBuffer } },
          { binding: 5, resource: { buffer: this.tileSpotListBuffer } },
        ],
      );
    }
    return this.renderDataBindGroup;
  }

  public dispose(): void {
    this.paramsBuffer?.destroy();
    this.pointLightBuffer?.destroy();
    this.spotLightBuffer?.destroy();
    this.tileLightCountBuffer?.destroy();
    this.tilePointListBuffer?.destroy();
    this.tileSpotListBuffer?.destroy();
    this.isLoaded = false;
  }
}
