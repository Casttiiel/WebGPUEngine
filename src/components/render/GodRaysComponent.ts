import { vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CameraComponent } from './CameraComponent';
import { DirectionalLightComponent } from './DirectionalLightComponent';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Render } from '../../renderer/core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';
import { GodRaysComponentData } from '../../types/GodRaysComponentData.type';

/**
 * GodRaysComponent — Steps 1 & 2: Occlusion mask + Radial blur.
 *
 * Step 1 — Occlusion mask pass:
 *   Produces a quarter-resolution RGBA mask where pixels brighter than
 *   `occlusionThreshold` (sky / sun halo) are white and everything else
 *   (geometry that occludes light) is black.
 *
 * Step 2 — Radial blur (Crytek light shafts):
 *   Marches 64 samples from each fragment toward the sun NDC position,
 *   accumulating the occlusion mask with exponential decay to produce
 *   directional light shafts at quarter resolution.
 *
 * apply() still returns the input HDR texture UNCHANGED — composite
 * blending is reserved for Step 4.
 *
 * GodRaysParams uniform layout (32 bytes — 8 × f32):
 *   [0] sunNdcX            — sun X in NDC [-1, 1]
 *   [1] sunNdcY            — sun Y in NDC [-1, 1]
 *   [2] occlusionThreshold — luma cutoff (sky = bright, geometry = dark)
 *   [3] enabled            — 1 = on, 0 = skip
 *   [4] intensity          — linear multiplier on radial output
 *   [5] density            — march step-length factor
 *   [6] decay              — per-step illumination falloff < 1
 *   [7] weight             — per-sample contribution weight
 */
export class GodRaysComponent extends Component {
  // ─── GPU resources ────────────────────────────────────────────────────────
  private technique!: Technique;
  private radialTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private occlusionMask!: RenderTarget;
  private radialBlurRT!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;

  // ─── Bind group caches ────────────────────────────────────────────────────
  private paramsBindGroup: GPUBindGroup | null = null;
  private radialParamsBindGroup: GPUBindGroup | null = null;
  private inputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private radialInputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ─── Tuneable parameters ───────────────────────────────────────────────────
  public isEnabled: boolean = true;
  /** Luminance threshold above which a pixel is treated as sky/sun [0, 1]. */
  public occlusionThreshold: number = 0.8;
  /** Rays intensity multiplier (Step 2). */
  public intensity: number = 1.0;
  /** Sample density along the radial march (Step 2). */
  public density: number = 0.96;
  /** Per-step light decay < 1 fades rays with distance (Step 2). */
  public decay: number = 0.97;
  /** Final accumulated-rays weight (Step 2). */
  public weight: number = 0.4;

  private loaded = false;

  // ─── Reusable arrays to avoid hot-path allocations ────────────────────────
  private readonly paramsData = new Float32Array(8);
  private readonly clipPos = vec4.create();
  private readonly sunWorld = vec4.create();

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public async load(data?: GodRaysComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this.isEnabled = data.enabled;
      if (data.occlusionThreshold !== undefined) this.occlusionThreshold = data.occlusionThreshold;
      if (data.intensity !== undefined) this.intensity = data.intensity;
      if (data.density !== undefined) this.density = data.density;
      if (data.decay !== undefined) this.decay = data.decay;
      if (data.weight !== undefined) this.weight = data.weight;
    }

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/god_rays_occlusion.tech');
    this.radialTechnique = await Technique.getAsync('post-processing/god_rays_radial.tech');

    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'god_rays_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.radialBlurRT = new RenderTarget();
    this.radialBlurRT.createRT(
      'god_rays_radial.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // 8 floats × 4 bytes = 32 bytes, matching GodRaysParams in WGSL
    this.paramsBuffer = GPUUtils.createBuffer(
      'god_rays_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Params are at group(3) of the occlusion technique
    this.paramsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_params_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // Params are at group(2) of the radial technique — same buffer, different layout
    this.radialParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_radial_params_bindgroup',
      this.radialTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    this.renderPassManager = new RenderPassManager();
    this.loaded = true;
  }

  public resize(): void {
    if (!this.loaded) return;

    this.occlusionMask.destroy();
    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'god_rays_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.radialBlurRT.destroy();
    this.radialBlurRT = new RenderTarget();
    this.radialBlurRT.createRT(
      'god_rays_radial.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // Cached bind groups reference stale texture views after resize — clear them.
    this.inputBindGroupCache.clear();
    this.radialInputBindGroupCache.clear();
  }

  // ─── Per-frame apply ──────────────────────────────────────────────────────

  /**
   * Run the god rays pipeline (Steps 1 & 2) and return the input HDR
   * texture unchanged.  Composite blending is reserved for Step 4.
   *
   * Step 1 — Occlusion mask: quarter-res RGBA mask from HDR + GBuffer depth.
   * Step 2 — Radial blur:    64-sample march toward the sun with decay.
   */
  public apply(hdrTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded) return hdrTexture;

    this.updateParamsBuffer();

    // ── Step 1: occlusion mask ───────────────────────────────────────────────
    const inputBindGroup = this.getOrCreateInputBindGroup(hdrTexture);
    this.renderPassManager.executeGodRaysOcclusionPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      inputBindGroup,
      this.paramsBindGroup!,
      this.occlusionMask,
    );

    // ── Step 2: radial blur (light shafts) ───────────────────────────────────
    const radialInputBG = this.getOrCreateRadialInputBindGroup(this.occlusionMask.getView());
    this.renderPassManager.executeGodRaysRadialPass(
      this.fullscreenQuadMesh,
      this.radialTechnique,
      radialInputBG,
      this.radialParamsBindGroup!,
      this.radialBlurRT,
    );

    return hdrTexture;
  }

  /** Quarter-resolution occlusion mask (Step 1 output). */
  public getOcclusionMaskView(): GPUTextureView {
    return this.occlusionMask.getView();
  }

  /** Quarter-resolution radial blur / light shafts buffer (Step 2 output). */
  public getRadialBlurView(): GPUTextureView {
    return this.radialBlurRT.getView();
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}

  public override renderDebug(): void {}

  public override dispose(): void {
    this.paramsBuffer?.destroy();
    this.occlusionMask?.destroy();
    this.radialBlurRT?.destroy();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private maskWidth(): number {
    return Math.max(1, Render.width >> 2);
  }

  private maskHeight(): number {
    return Math.max(1, Render.height >> 2);
  }

  /**
   * Write GodRaysParams into the uniform buffer.
   * Sun NDC position is computed from the first directional light in the scene
   * using the camera's view-projection matrix (CPU-side).
   */
  private updateParamsBuffer(): void {
    let sunNdcX = 0.0;
    let sunNdcY = 0.0;

    try {
      const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
      const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | null;
      const cam = cameraComp?.getCamera();

      const dirLights =
        Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];

      if (cam && dirLights.length > 0) {
        const dl = dirLights[0] as DirectionalLightComponent;
        const dir = dl.getLightDirectionToSource(); // world-space direction TO the light
        const camPos = cam.getPosition();
        const vp = cam.getViewProjection();

        // Project a point far in the light direction to get sun clip-space position.
        const farDist = 1e5;
        this.sunWorld[0] = camPos[0] + dir[0] * farDist;
        this.sunWorld[1] = camPos[1] + dir[1] * farDist;
        this.sunWorld[2] = camPos[2] + dir[2] * farDist;
        this.sunWorld[3] = 1.0;

        vec4.transformMat4(this.clipPos, this.sunWorld, vp);

        // Only map to NDC when the sun is in front of the camera (w > 0).
        if (this.clipPos[3] > 0.0) {
          sunNdcX = this.clipPos[0] / this.clipPos[3];
          sunNdcY = this.clipPos[1] / this.clipPos[3];
        }
      }
    } catch {
      // If any lookup fails, leave sunNdc at (0, 0) — harmless for Step 1.
    }

    this.paramsData[0] = sunNdcX;
    this.paramsData[1] = sunNdcY;
    this.paramsData[2] = this.occlusionThreshold;
    this.paramsData[3] = this.isEnabled ? 1.0 : 0.0;
    this.paramsData[4] = this.intensity;
    this.paramsData[5] = this.density;
    this.paramsData[6] = this.decay;
    this.paramsData[7] = this.weight;

    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  /** Get (or lazily create) the HDR input bind group for the occlusion pass.
   * HDR input is at group(2) of the occlusion technique. */
  private getOrCreateInputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.inputBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        'god_rays_input_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.inputBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /** Get (or lazily create) the occlusion-mask input bind group for the radial pass.
   * Mask input is at group(1) of the radial technique (SingleTexture). */
  private getOrCreateRadialInputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.radialInputBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        'god_rays_radial_input_bindgroup',
        this.radialTechnique.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.radialInputBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }
}
