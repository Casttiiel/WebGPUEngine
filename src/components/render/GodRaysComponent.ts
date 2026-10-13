import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
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
 * GodRaysComponent — Volumetric god rays via per-pixel shadow-map raymarch.
 *
 * Marches along each pixel's world-space view ray and samples the CSM shadow
 * maps at every step, accumulating in-scattered directional light.  Visible
 * from ANY camera angle, not just when looking toward the sun.
 *
 * Pipeline (all intermediate buffers are half-res rgba16float, r = scatter, g = depth):
 *   Step 1 — Volumetric march: ray bounded to min(geometry, CSM range, maxDistance),
 *                               world-space step size, per-frame IGN jitter (TAA resolves it).
 *   Step 2 — Bilateral blur:   separable depth-aware Gaussian (H then V).
 *   Step 3 — Composite:        joint-bilateral upsample + additive blend onto HDR,
 *                               tinted by the DirectionalLight colour.
 *
 * VolumetricGodRaysParams layout (32 bytes — 8 × f32):
 *   [0] density     — σs per world unit
 *   [1] extinction  — σt per world unit
 *   [2] anisotropy  — Henyey-Greenstein g
 *   [3] enabled     — 0 = skip pass, 1 = compute shafts
 *   [4] maxSteps    — upper bound on raymarch steps
 *   [5] stepSize    — target step length (world units)
 *   [6] maxDistance — max march distance (world units)
 *   [7]             — padding
 */
export class GodRaysComponent extends Component {
  // ─── GPU resources ────────────────────────────────────────────────────────
  private volumetricTechnique!: Technique;
  private blurTechnique!: Technique;
  private compositeTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private volumetricRT!: RenderTarget;
  private blurRT!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;
  private compositeParamsBuffer!: GPUBuffer;

  // ─── Bind group caches ────────────────────────────────────────────────────
  private volumetricParamsBindGroup: GPUBindGroup | null = null;
  private compositeParamsBindGroup: GPUBindGroup | null = null;
  private defaultExposureBuffer!: GPUBuffer;
  private compositeExposureBindGroup!: GPUBindGroup;
  private trackedExposureBuffer: GPUBuffer | null = null;

  // CSM bind group for the volumetric pass — rebuilt when shadow view changes.
  private csmBindGroup: GPUBindGroup | null = null;
  private cachedShadowView0: GPUTextureView | null = null;

  // Blur: H pass reads volumetricRT → blurRT, V pass reads blurRT → volumetricRT.
  // The composite then reads volumetricRT.
  private volumetricInputBG!: GPUBindGroup;
  private blurInputBG!: GPUBindGroup;
  private blurParamsBuffers: GPUBuffer[] = [];
  private blurParamsBindGroups: GPUBindGroup[] = [];

  // ─── Tuneable parameters ───────────────────────────────────────────────────
  public isEnabled: boolean = true;
  /** Scattering coefficient σs per world unit — controls in-scatter strength. */
  public density: number = 0.02;
  /** Extinction coefficient σt per world unit — fog transmittance along the view ray. */
  public extinction: number = 0.01;
  /** Henyey-Greenstein anisotropy g — higher = stronger glow when looking toward the sun. */
  public anisotropy: number = 0.4;
  /** Target raymarch step length in world units. */
  public stepSize: number = 1.0;
  /** Upper bound on raymarch steps per pixel. */
  public numSteps: number = 64;
  /** Max march distance in world units (also capped by the CSM shadow range). */
  public maxDistance: number = 80;
  /** Relative depth tolerance of the bilateral blur. */
  public blurDepthSigma: number = 0.05;
  /** Linear brightness multiplier applied to the accumulated volumetric light. */
  public intensity: number = 1.0;
  /** Composite-pass scale applied on top of intensity. */
  public compositeScale: number = 1.0;

  private loaded = false;

  // ─── Reusable arrays to avoid hot-path allocations ────────────────────────
  private readonly paramsData = new Float32Array(8);
  private readonly compositeParamsData = new Float32Array(4);
  private readonly blurParamsData = new Float32Array(4);

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public async load(data?: GodRaysComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this.isEnabled = data.enabled;
      if (data.density !== undefined) this.density = data.density;
      if (data.extinction !== undefined) this.extinction = data.extinction;
      if (data.anisotropy !== undefined) this.anisotropy = data.anisotropy;
      if (data.stepSize !== undefined) this.stepSize = data.stepSize;
      if (data.numSteps !== undefined) this.numSteps = data.numSteps;
      if (data.maxDistance !== undefined) this.maxDistance = data.maxDistance;
      if (data.blurDepthSigma !== undefined) this.blurDepthSigma = data.blurDepthSigma;
      if (data.intensity !== undefined) this.intensity = data.intensity;
      if (data.compositeScale !== undefined) this.compositeScale = data.compositeScale;
    }

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.volumetricTechnique = await Technique.getAsync('post-processing/god_rays_volumetric.tech');
    this.blurTechnique = await Technique.getAsync('post-processing/god_rays_bilateral.tech');
    this.compositeTechnique = await Technique.getAsync('post-processing/god_rays_composite.tech');

    this.createRenderTargets();

    // 8 floats × 4 bytes = 32 bytes, matching VolumetricGodRaysParams in WGSL.
    this.paramsBuffer = GPUUtils.createBuffer(
      'god_rays_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Volumetric params are at group(3) of the volumetric technique.
    this.volumetricParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_params_bindgroup',
      this.volumetricTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // Composite params: 4 × f32 = 16 bytes { sunR, sunG, sunB, scale }.
    this.compositeParamsBuffer = GPUUtils.createBuffer(
      'god_rays_composite_params_buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.compositeParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_params_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.compositeParamsBuffer } }],
    );

    // Default exposure buffer (1.0) used until AutoExposureComponent provides its own.
    this.defaultExposureBuffer = GPUUtils.createBuffer(
      'god_rays_default_exposure',
      4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    GPUUtils.writeBuffer(this.defaultExposureBuffer, 0, new Float32Array([1.0]));
    this.compositeExposureBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_exposure_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.defaultExposureBuffer } }],
    );

    // Blur: one params buffer per direction (H, V). Separate buffers because
    // writeBuffer is applied before submit — a single buffer written twice would
    // only see the last value in both passes.
    const blurParamsLayout = this.blurTechnique.getPipeline().getBindGroupLayout(2);
    for (let i = 0; i < 2; i++) {
      const buf = GPUUtils.createBuffer(
        `god_rays_blur_params_${i}`,
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      this.blurParamsBuffers.push(buf);
      this.blurParamsBindGroups.push(
        BindGroupFactory.createBindGroup(`god_rays_blur_params_bindgroup_${i}`, blurParamsLayout, [
          { binding: 0, resource: { buffer: buf } },
        ]),
      );
    }

    this.rebuildInputBindGroups();

    this.renderPassManager = new RenderPassManager();
    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'god_rays', (comp) => {
      const c = comp as GodRaysComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;

    this.createRenderTargets();

    // Cached bind groups reference stale texture views after resize — rebuild them.
    this.csmBindGroup = null;
    this.cachedShadowView0 = null;
    this.rebuildInputBindGroups();
  }

  // ─── Per-frame apply ──────────────────────────────────────────────────────

  /**
   * Run the complete volumetric god rays pipeline and return the same HDR
   * texture with god rays additively blended in.
   *
   * Returns unmodified hdrTexture if no valid directional light with shadows
   * is found in the scene.
   */
  public apply(hdrTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded || !this.isEnabled) return hdrTexture;

    // CSM bind group — requires a directional light with shadow maps.
    const csmBG = this.getOrCreateCSMBindGroup();
    if (!csmBG) return hdrTexture;

    this.updateParamsBuffers();

    // ── Step 1: volumetric light scatter (half-res) ──────────────────────────
    this.renderPassManager.executeGodRaysVolumetricPass(
      this.fullscreenQuadMesh,
      this.volumetricTechnique,
      gBufferBindGroup,
      csmBG,
      this.volumetricParamsBindGroup!,
      this.volumetricRT,
    );

    // ── Step 2: separable bilateral blur (H → blurRT, V → volumetricRT) ──────
    this.renderPassManager.executeGodRaysBlurPass(
      this.fullscreenQuadMesh,
      this.blurTechnique,
      this.volumetricInputBG,
      this.blurParamsBindGroups[0]!,
      this.blurRT,
      'God Rays Blur H',
    );
    this.renderPassManager.executeGodRaysBlurPass(
      this.fullscreenQuadMesh,
      this.blurTechnique,
      this.blurInputBG,
      this.blurParamsBindGroups[1]!,
      this.volumetricRT,
      'God Rays Blur V',
    );

    // ── Step 3: joint-bilateral upsample + additive blend onto HDR ───────────
    this.renderPassManager.executeGodRaysCompositePass(
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      hdrTexture,
      gBufferBindGroup,
      this.volumetricInputBG,
      this.compositeParamsBindGroup!,
      this.compositeExposureBindGroup,
    );

    return hdrTexture;
  }

  /** Half-resolution blurred light shafts (r = scatter, g = depth). */
  public getVolumetricView(): GPUTextureView {
    return this.volumetricRT.getView();
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('God Rays');
    this._editorFolder.close();
    this._editorFolder.add(this, 'isEnabled').name('Enable').listen();
    this._editorFolder.add(this, 'density', 0.0, 0.2, 0.001).name('Density (σs)').listen();
    this._editorFolder.add(this, 'extinction', 0.0, 0.1, 0.001).name('Extinction (σt)').listen();
    this._editorFolder.add(this, 'anisotropy', 0.0, 0.95, 0.01).name('Anisotropy (g)').listen();
    this._editorFolder.add(this, 'stepSize', 0.1, 5.0, 0.05).name('Step Size (m)').listen();
    this._editorFolder.add(this, 'numSteps', 8, 128, 1).name('Max Steps').listen();
    this._editorFolder.add(this, 'maxDistance', 5, 500, 1).name('Max Distance (m)').listen();
    this._editorFolder.add(this, 'blurDepthSigma', 0.005, 0.5, 0.005).name('Blur Depth σ').listen();
    this._editorFolder.add(this, 'intensity', 0.0, 5.0, 0.05).name('Intensity').listen();
    this._editorFolder.add(this, 'compositeScale', 0.0, 4.0, 0.05).name('Composite Scale').listen();
  }

  public override renderDebug(): void {}

  public override dispose(): void {
    this.paramsBuffer?.destroy();
    this.compositeParamsBuffer?.destroy();
    this.defaultExposureBuffer?.destroy();
    this.volumetricRT?.destroy();
    this.blurRT?.destroy();
    for (const buf of this.blurParamsBuffers) buf?.destroy();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Wire the GPU exposure buffer from AutoExposureComponent into the composite pass.
   * If the buffer reference is unchanged, the existing bind group is reused.
   */
  public setExposureBuffer(buf: GPUBuffer): void {
    if (buf === this.trackedExposureBuffer) return;
    this.trackedExposureBuffer = buf;
    this.compositeExposureBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_exposure_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: buf } }],
    );
  }

  private createRenderTargets(): void {
    const w = Math.max(1, Render.width >> 1);
    const h = Math.max(1, Render.height >> 1);

    this.volumetricRT?.destroy();
    this.volumetricRT = new RenderTarget();
    this.volumetricRT.createRT('god_rays_volumetric.dds', w, h, 'rgba16float');

    this.blurRT?.destroy();
    this.blurRT = new RenderTarget();
    this.blurRT.createRT('god_rays_blur.dds', w, h, 'rgba16float');
  }

  /** Return the first DirectionalLightComponent found in the scene, or null. */
  private getFirstDirectionalLight(): DirectionalLightComponent | null {
    try {
      const dirLights =
        Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];
      return dirLights.length > 0 ? (dirLights[0] as DirectionalLightComponent) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get (or lazily create) the CSM bind group for the volumetric technique (group 2).
   * Returns null when no directional light with shadows exists in the scene.
   * Cached by the shadow-map view pointer — rebuilt only when the view changes.
   */
  private getOrCreateCSMBindGroup(): GPUBindGroup | null {
    const dl = this.getFirstDirectionalLight();
    if (!dl || !dl.getHasShadows()) return null;

    const view0 = dl.getShadowDepthView(0);
    if (!view0) return null;

    // Re-use cached bind group if the primary shadow view hasn't changed.
    if (view0 === this.cachedShadowView0 && this.csmBindGroup) {
      return this.csmBindGroup;
    }

    this.cachedShadowView0 = view0;
    // Fall back to cascade 0 for scenes with fewer than 3 cascades.
    const view1 = dl.getShadowDepthView(1) ?? view0;
    const view2 = dl.getShadowDepthView(2) ?? view0;

    this.csmBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_csm_bindgroup',
      this.volumetricTechnique.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: { buffer: dl.getUniformBuffer() } },
        { binding: 1, resource: view0 },
        { binding: 2, resource: view1 },
        { binding: 3, resource: view2 },
        { binding: 4, resource: dl.getShadowSampler() },
      ],
    );
    return this.csmBindGroup;
  }

  /**
   * Write volumetric, blur and composite params into their GPU buffers.
   * Also reads sun colour from the directional light for the composite tint.
   */
  private updateParamsBuffers(): void {
    this.paramsData[0] = this.density;
    this.paramsData[1] = this.extinction;
    this.paramsData[2] = this.anisotropy;
    this.paramsData[3] = this.isEnabled ? 1.0 : 0.0;
    this.paramsData[4] = Math.max(4, this.numSteps);
    this.paramsData[5] = Math.max(0.01, this.stepSize);
    this.paramsData[6] = Math.max(0.1, this.maxDistance);
    // [7] padding — left as 0
    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);

    const depthSigma = Math.max(0.001, this.blurDepthSigma);
    this.blurParamsData.set([1, 0, depthSigma, 0]);
    GPUUtils.writeBuffer(this.blurParamsBuffers[0]!, 0, this.blurParamsData);
    this.blurParamsData.set([0, 1, depthSigma, 0]);
    GPUUtils.writeBuffer(this.blurParamsBuffers[1]!, 0, this.blurParamsData);

    // Sun colour for the composite tint (falls back to white if no light found).
    let sunR = 1.0;
    let sunG = 1.0;
    let sunB = 1.0;
    const dl = this.getFirstDirectionalLight();
    if (dl) {
      const color = dl.getColor();
      sunR = color[0] ?? 1.0;
      sunG = color[1] ?? 1.0;
      sunB = color[2] ?? 1.0;
    }

    this.compositeParamsData[0] = sunR;
    this.compositeParamsData[1] = sunG;
    this.compositeParamsData[2] = sunB;
    this.compositeParamsData[3] = this.isEnabled ? this.intensity * this.compositeScale : 0.0;
    GPUUtils.writeBuffer(this.compositeParamsBuffer, 0, this.compositeParamsData);
  }

  /**
   * (Re-)build the input bind groups for the blur and composite passes.
   * Must be called after the RTs are (re-)created at load and resize time.
   */
  private rebuildInputBindGroups(): void {
    // Blur and composite both use the SingleTexture layout at group(1).
    const layout = this.blurTechnique.getPipeline().getBindGroupLayout(1);
    this.volumetricInputBG = BindGroupFactory.createBindGroup('god_rays_volumetric_input', layout, [
      { binding: 0, resource: this.volumetricRT.getView() },
      { binding: 1, resource: SamplerLibrary.simpleSampler },
    ]);
    this.blurInputBG = BindGroupFactory.createBindGroup('god_rays_blur_input', layout, [
      { binding: 0, resource: this.blurRT.getView() },
      { binding: 1, resource: SamplerLibrary.simpleSampler },
    ]);
  }
}
