import { vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
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
import { LensFlareComponentData } from '../../types/LensFlareComponentData.type';

/**
 * LensFlareComponent — screen-space lens flare for the sun / directional light.
 *
 * Step 1 — Occlusion mask : quarter-res RGBA mask — sky near sun = white,
 *                            geometry = black.
 * Step 2 — Flare composite: additive full-res pass that reads the occlusion
 *                            mask near the sun UV for a visibility factor, then
 *                            renders main glow, corona ring, anamorphic streak,
 *                            and 6 chromatic ghost discs along the flare axis.
 *
 * LensFlareParams uniform layout (32 bytes — 8 × f32):
 *   [0] sunNdcX    — sun X in NDC [-1, 1]
 *   [1] sunNdcY    — sun Y in NDC [-1, 1]
 *   [2] intensity  — overall flare scale
 *   [3] enabled    — 1 = on, 0 = skip
 *   [4] sunR       — sun / directional-light colour red
 *   [5] sunG       — sun colour green
 *   [6] sunB       — sun colour blue
 *   [7] ghostScale — ghost element size factor
 */
export class LensFlareComponent extends Component {
  // ─── GPU resources ────────────────────────────────────────────────────────
  private occlusionTechnique!: Technique;
  private compositeTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private occlusionMask!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;

  // ─── Bind group caches ────────────────────────────────────────────────────
  private occlusionParamsBindGroup: GPUBindGroup | null = null;
  private compositeParamsBindGroup: GPUBindGroup | null = null;
  private occlusionInputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // ─── Tuneable parameters ───────────────────────────────────────────────────
  public isEnabled: boolean = true;
  /** Overall flare intensity [0, 5]. */
  public intensity: number = 1.0;
  /** Ghost element size factor [0.3, 3.0]. */
  public ghostScale: number = 1.0;

  private loaded = false;

  // ─── Reusable arrays ──────────────────────────────────────────────────────
  private readonly paramsData = new Float32Array(8);
  private readonly clipPos = vec4.create();
  private readonly sunWorld = vec4.create();

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public async load(data?: LensFlareComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this.isEnabled = data.enabled;
      if (data.intensity !== undefined) this.intensity = data.intensity;
      if (data.ghostScale !== undefined) this.ghostScale = data.ghostScale;
    }

    [this.fullscreenQuadMesh, this.occlusionTechnique, this.compositeTechnique] = await Promise.all(
      [
        Mesh.getAsync('fullscreenquad.obj'),
        Technique.getAsync('post-processing/lens_flare_occlusion.tech'),
        Technique.getAsync('post-processing/lens_flare.tech'),
      ],
    );

    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'lens_flare_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // 8 × f32 = 32 bytes
    this.paramsBuffer = GPUUtils.createBuffer(
      'lens_flare_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // group(2) of the occlusion technique — GodRaysUniforms layout (single UBO).
    this.occlusionParamsBindGroup = BindGroupFactory.createBindGroup(
      'lens_flare_occlusion_params_bg',
      this.occlusionTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // group(2) of the composite technique — same layout.
    this.compositeParamsBindGroup = BindGroupFactory.createBindGroup(
      'lens_flare_composite_params_bg',
      this.compositeTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    this.renderPassManager = new RenderPassManager();
    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'lens_flare', (comp) => {
      const c = comp as LensFlareComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;

    this.occlusionMask.destroy();
    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'lens_flare_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // Invalidate cached bind groups — texure views are stale after resize.
    this.occlusionInputBindGroupCache.clear();
  }

  // ─── Per-frame apply ──────────────────────────────────────────────────────

  /**
   * Execute the lens flare pipeline and return the same HDR texture view
   * (the flare contribution is additively blended in-place).
   *
   * @param hdrTexture  Full-resolution HDR scene view.
   * @param gBufferBindGroup  Standard GBuffer bind group for depth read-back.
   */
  public apply(hdrTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded) return hdrTexture;

    this.updateParamsBuffer();

    // ── Step 1: occlusion mask (quarter-res) ─────────────────────────────────
    this.renderPassManager.executeLensFlareOcclusionPass(
      this.fullscreenQuadMesh,
      this.occlusionTechnique,
      gBufferBindGroup,
      this.occlusionParamsBindGroup!,
      this.occlusionMask,
    );

    // ── Step 2: flare composite (full-res, additive) ──────────────────────────
    const occlusionBG = this.getOrCreateOcclusionInputBindGroup(this.occlusionMask.getView());
    this.renderPassManager.executeLensFlareCompositePass(
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      hdrTexture,
      occlusionBG,
      this.compositeParamsBindGroup!,
    );

    // The composite blended in-place; return the same view.
    return hdrTexture;
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}
  public override renderDebug(): void {}

  public override dispose(): void {
    this.paramsBuffer?.destroy();
    this.occlusionMask?.destroy();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private updateParamsBuffer(): void {
    let sunNdcX = 0.0;
    let sunNdcY = 0.0;
    let sunR = 1.0;
    let sunG = 0.95;
    let sunB = 0.8;
    // Luminance-scaled effective intensity (accounts for day/night brightness).
    let effectiveIntensity = this.intensity;
    // Only render when the sun is in front of the camera and within screen bounds.
    let sunInFront = false;

    try {
      const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
      const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | null;
      const cam = cameraComp?.getCamera();

      const dirLights =
        Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];

      if (cam && dirLights.length > 0) {
        const dl = dirLights[0] as DirectionalLightComponent;
        const dir = dl.getLightDirectionToSource();
        const camPos = cam.getPosition();
        const vp = cam.getViewProjection();

        const color = dl.getColor();
        sunR = color[0] ?? 1.0;
        sunG = color[1] ?? 0.95;
        sunB = color[2] ?? 0.8;

        // Effective luminance = perceptual luminance × light intensity, normalised
        // against typical sun max (10.0).  This correctly distinguishes:
        //   Day sun  : color luma ≈ 0.96 × intensity 10  → normalised ≈ 0.96 → flare full
        //   Night moon: color luma ≈ 0.70 × intensity 0.2 → normalised ≈ 0.014 → flare ~0%
        const colorLuminance = sunR * 0.2126 + sunG * 0.7152 + sunB * 0.0722;
        const lightIntensity = dl.getIntensity();
        const normalised = Math.min(1.0, (colorLuminance * lightIntensity) / 10.0);
        effectiveIntensity = this.intensity * Math.pow(Math.max(0, normalised), 2.0);

        const farDist = 1e5;
        this.sunWorld[0] = camPos[0] + dir[0] * farDist;
        this.sunWorld[1] = camPos[1] + dir[1] * farDist;
        this.sunWorld[2] = camPos[2] + dir[2] * farDist;
        this.sunWorld[3] = 1.0;

        vec4.transformMat4(this.clipPos, this.sunWorld, vp);

        // clipPos[3] (w) > 0 means the point is in front of the near plane.
        // Additionally guard against degenerate NDC coords far outside screen
        // bounds (NDC magnitude > 3 in either axis means deeply off-screen).
        if (this.clipPos[3] > 0.0) {
          sunNdcX = this.clipPos[0] / this.clipPos[3];
          sunNdcY = this.clipPos[1] / this.clipPos[3];

          // Only mark in-front if NDC is within a generous off-screen margin.
          // The shader's edge-fade handles the [1, 2] range smoothly.
          if (Math.abs(sunNdcX) < 3.0 && Math.abs(sunNdcY) < 3.0) {
            sunInFront = true;
          }
        }
      }
    } catch {
      // Use defaults if any lookup fails.
    }

    this.paramsData[0] = sunNdcX;
    this.paramsData[1] = sunNdcY;
    this.paramsData[2] = effectiveIntensity;
    this.paramsData[3] = this.isEnabled && sunInFront ? 1.0 : 0.0;
    this.paramsData[4] = sunR;
    this.paramsData[5] = sunG;
    this.paramsData[6] = sunB;
    this.paramsData[7] = this.ghostScale;
    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  /** Lazily create / cache the occlusion-mask input bind group for the composite pass.
   * Mask is at group(1) of the composite technique (SingleTexture layout). */
  private getOrCreateOcclusionInputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bg = this.occlusionInputBindGroupCache.get(texture);
    if (!bg) {
      bg = BindGroupFactory.createBindGroup(
        'lens_flare_occlusion_input_bg',
        this.compositeTechnique.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.occlusionInputBindGroupCache.set(texture, bg);
    }
    return bg;
  }

  private maskWidth(): number {
    return Math.max(1, Render.width >> 2);
  }

  private maskHeight(): number {
    return Math.max(1, Render.height >> 2);
  }
}
